import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";
import { classifyRoundTrip } from "./window.js";
import { verifiedSwapsByTx } from "./venue-swaps.js";

/**
 * Daily volume broken into mutually-exclusive categories, for the
 * "Volume" stacked-bars chart. Same per-tx classification as
 * lifetime-conversions, but bucketed by UTC day:
 *
 *   - Swap: round-trip txs (a withdrawal of token A + a deposit of token
 *     B in one tx) whose receipt contains the venue's own swap event —
 *     venue-verified via services/venue-verify.ts, valued at the venue's
 *     reported amounts (methodology + example tx: core protocols/venues.ts).
 *   - Stake / lend: round-trips into wrapper receipts by the symbol
 *     conventions in window.ts (xSTRK → Endur, vUSDC/pUSDC → Vesu).
 *   - Everything else is a plain pool flow: deposits → shieldedIn,
 *     withdrawals → shieldedOut.
 *
 * Mutually exclusive by construction: a round-trip's legs are counted
 * ONCE (out leg, as swap/stake/lend) and never also as shieldedIn/Out,
 * so the bands can stack without double-counting. All figures are USD at
 * current registry prices, and are floors (same caveats as
 * lifetime-conversions — split or same-token activity leaves no
 * countable signature).
 */

export interface VolumeHistoryPoint {
  date: string; // YYYY-MM-DD (UTC)
  shieldedInUsd: number;
  shieldedOutUsd: number;
  swapUsd: number;
  stakeUsd: number;
  lendUsd: number;
}

export interface VolumeHistory {
  days: VolumeHistoryPoint[];
  pricedAt: "current";
}

export function volumeHistory(db: Db, chain: string, pool: string): VolumeHistory {
  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);

  const rows = db
    .prepare(
      `SELECT tx_hash, substr(timestamp_iso, 1, 10) AS day, topic0, topic2, data_json
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?, ?)
       ORDER BY timestamp_iso ASC`
    )
    .all(
      chain,
      pool,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.OpenNoteDeposited,
      EVENT_SELECTORS.Withdrawal
    ) as {
    tx_hash: string;
    day: string;
    topic0: string;
    topic2: string | null;
    data_json: string;
  }[];

  // Accumulate each tx's legs: its day, the token sets crossing in/out,
  // and the USD value of each side (deposit amount at data[0], withdrawal
  // amount at data[3] — same offsets lifetime-conversions/tvl-history use).
  interface TxAcc {
    day: string;
    outs: Set<string>;
    ins: Set<string>;
    inUsd: number;
    outUsd: number;
  }
  const byTx = new Map<string, TxAcc>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) {
      e = { day: r.day, outs: new Set(), ins: new Set(), inUsd: 0, outUsd: 0 };
      byTx.set(r.tx_hash, e);
    }
    const tok = normalizeHex(r.topic2);
    const isOut = normalizeHex(r.topic0) === WD;
    let usd = 0;
    const meta = lookupToken(tok);
    if (meta && meta.usdApprox > 0) {
      try {
        const data = JSON.parse(r.data_json) as string[];
        const raw = BigInt(data[isOut ? 3 : 0] ?? "0x0");
        usd = applyDecimals(raw, meta.decimals) * meta.usdApprox;
      } catch {
        /* malformed row — keep the leg, skip its value */
      }
    }
    if (isOut) {
      e.outs.add(tok);
      e.outUsd += usd;
    } else {
      e.ins.add(tok);
      e.inUsd += usd;
    }
  }

  const byDay = new Map<string, VolumeHistoryPoint>();
  const dayOf = (day: string): VolumeHistoryPoint => {
    let d = byDay.get(day);
    if (!d) {
      d = { date: day, shieldedInUsd: 0, shieldedOutUsd: 0, swapUsd: 0, stakeUsd: 0, lendUsd: 0 };
      byDay.set(day, d);
    }
    return d;
  };

  // Swaps are VENUE-VERIFIED, not inferred: a tx counts as swap only if
  // its receipt contained the venue's own swap event (AVNU Swap / Ekubo
  // Swapped — see services/venue-verify.ts), valued at venue-reported
  // amounts when priced. Cross-token round-trips without a venue event
  // (including those the verifier hasn't fetched yet, ~1 tick of lag)
  // count as plain pool flows. Stake/lend keep the wrapper-convention
  // classification — the receipt path for Vesu/Endur is future work.
  const verified = verifiedSwapsByTx(db, chain);
  for (const [txHash, tx] of byTx) {
    const d = dayOf(tx.day);
    // Wrap conventions outrank the venue event: STRK→xSTRK routed via
    // AVNU emits a Swap event too, but the user's intent is staking.
    const kind = classifyRoundTrip(tx.outs, tx.ins);
    const v = verified.get(txHash);
    if (kind === "stake") d.stakeUsd += tx.outUsd;
    else if (kind === "lend") d.lendUsd += tx.outUsd;
    else if (v) d.swapUsd += v.usd ?? tx.outUsd;
    else {
      // Plain pool flow: count each leg present.
      d.shieldedInUsd += tx.inUsd;
      d.shieldedOutUsd += tx.outUsd;
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { days, pricedAt: "current" };
}
