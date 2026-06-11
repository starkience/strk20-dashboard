import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";
import { classifyRoundTrip } from "./window.js";

/**
 * All-time in-pool activity derived from event footprints, powering the
 * pool panel's "all-time" stat grid.
 *
 * Conversions: a tx containing both a Withdrawal of token A and a
 * Deposit of token B is a round-trip through an external venue. The
 * USD size of each is valued on its OUT leg (withdrawal amounts ×
 * live registry price) — the amount that actually left to trade,
 * stake, or supply. Classification (swap / stake / lend) follows the
 * wrapper conventions in window.ts.
 *
 * Private transfers: txs with note activity (NoteUsed / EncNoteCreated)
 * and NO deposit or withdrawal — value moved between shielded notes
 * without ever touching the pool's public edge. Their size is
 * cryptographically hidden (that's the product), so this is a count,
 * not a volume.
 *
 * All figures are floors, not censuses: activity that splits across
 * transactions or stays same-token leaves no countable signature.
 */

export interface LifetimeConversions {
  swapCount: number;
  swapVolumeUsd: number;
  stakeCount: number;
  stakeVolumeUsd: number;
  lendCount: number;
  lendVolumeUsd: number;
  /** In-pool note-to-note transfer txs (count only — sizes are private). */
  privateTransfers: number;
}

export function lifetimeConversions(
  db: Db,
  chain: string,
  pool: string
): LifetimeConversions {
  const DEP = normalizeHex(EVENT_SELECTORS.Deposit);
  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);

  const rows = db
    .prepare(
      `SELECT tx_hash, topic0, topic2, data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?)`
    )
    .all(chain, pool, EVENT_SELECTORS.Deposit, EVENT_SELECTORS.Withdrawal) as {
    tx_hash: string;
    topic0: string;
    topic2: string | null;
    data_json: string;
  }[];

  interface TxAcc {
    outs: Set<string>;
    ins: Set<string>;
    outUsd: number;
  }
  const byTx = new Map<string, TxAcc>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) {
      e = { outs: new Set(), ins: new Set(), outUsd: 0 };
      byTx.set(r.tx_hash, e);
    }
    const tok = normalizeHex(r.topic2);
    if (normalizeHex(r.topic0) === DEP) {
      e.ins.add(tok);
    } else {
      e.outs.add(tok);
      // Withdrawal amount sits at data[3] (after enc_user_addr ×3).
      const meta = lookupToken(tok);
      if (meta && meta.usdApprox > 0) {
        try {
          const data = JSON.parse(r.data_json) as string[];
          const raw = BigInt(data[3] ?? "0x0");
          e.outUsd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
        } catch {
          /* malformed row — skip its value, keep the count */
        }
      }
    }
  }

  const out: LifetimeConversions = {
    swapCount: 0,
    swapVolumeUsd: 0,
    stakeCount: 0,
    stakeVolumeUsd: 0,
    lendCount: 0,
    lendVolumeUsd: 0,
    privateTransfers: 0,
  };
  for (const { outs, ins, outUsd } of byTx.values()) {
    const kind = classifyRoundTrip(outs, ins);
    if (kind === "swap") {
      out.swapCount += 1;
      out.swapVolumeUsd += outUsd;
    } else if (kind === "stake") {
      out.stakeCount += 1;
      out.stakeVolumeUsd += outUsd;
    } else if (kind === "lend") {
      out.lendCount += 1;
      out.lendVolumeUsd += outUsd;
    }
  }

  // Pure in-pool transfers: note events present, no edge events.
  const t = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT tx_hash FROM raw_events WHERE chain=? AND contract=?
         GROUP BY tx_hash
         HAVING SUM(topic0 IN (?, ?)) > 0 AND SUM(topic0 IN (?, ?)) = 0
       )`
    )
    .get(
      chain,
      pool,
      EVENT_SELECTORS.NoteUsed,
      EVENT_SELECTORS.EncNoteCreated,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.Withdrawal
    ) as { n: number };
  out.privateTransfers = Number(t?.n ?? 0);

  return out;
}
