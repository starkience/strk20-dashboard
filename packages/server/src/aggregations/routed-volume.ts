import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  protocolForAddress,
} from "@strk20/core";
import { verifiedSwapsByTx } from "./venue-swaps.js";
import { classifyRoundTrip } from "./window.js";

/**
 * Privately routed volume by protocol, daily — the "private actions per DeFi"
 * chart. In-pool round trips (a Withdrawal of token A + a Deposit /
 * OpenNoteDeposited of token B in the same tx), plus explicitly registered
 * one-way anonymizer withdrawals, are attributed to the protocol they route
 * through and valued on their OUT leg:
 *   - swap  → the venue from venue-verification (avnu / ekubo); valued at the
 *             venue-reported size, falling back to the withdrawal leg.
 *   - lend  → vesu        (wrap convention, see classifyRoundTrip)
 *   - stake → endur
 *   - prediction market → offmarket, when a Withdrawal is sent to one of
 *             OFFMARKET's registered anonymizers. Only the outbound value is
 *             counted: adding the later inbound settlement would count the
 *             same private position twice.
 * Unverified swaps (no venue event in the receipt) are not counted — same
 * floor-not-census basis as lifetime-conversions, so totals agree.
 */

export interface RoutedVolumeDay {
  date: string; // YYYY-MM-DD (UTC)
  total: number; // USD, == sum of byProtocol
  /** protocol id → USD routed that day (nonzero only). */
  byProtocol: Record<string, number>;
}

export interface RoutedVolume {
  days: RoutedVolumeDay[];
  /** Legend / stack order — always shows the core venues, then any extras. */
  protocols: string[];
}

// Lend wraps are Vesu, stake wraps are Endur (the live integrations).
const LEND_PROTOCOL = "vesu";
const STAKE_PROTOCOL = "endur";
// Always present in the legend (matches the reference), even on zero days.
const BASE_PROTOCOLS = ["avnu", "ekubo", "vesu", "offmarket"];

export function routedVolume(db: Db, chain: string, pool: string): RoutedVolume {
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, tx_hash, topic0, topic1, topic2, data_json
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
      day: string;
      tx_hash: string;
      topic0: string;
      topic1: string | null;
      topic2: string | null;
      data_json: string;
    }[];

  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);

  interface TxAcc {
    day: string;
    outs: Set<string>;
    ins: Set<string>;
    outUsd: number;
    offmarketOutUsd: number;
  }
  const byTx = new Map<string, TxAcc>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) {
      e = {
        day: r.day,
        outs: new Set(),
        ins: new Set(),
        outUsd: 0,
        offmarketOutUsd: 0,
      };
      byTx.set(r.tx_hash, e);
    }
    const tok = normalizeHex(r.topic2);
    if (normalizeHex(r.topic0) === WD) {
      e.outs.add(tok);
      const meta = lookupToken(tok);
      if (meta && meta.usdApprox > 0) {
        try {
          const data = JSON.parse(r.data_json) as string[];
          const usd = applyDecimals(BigInt(data[3] ?? "0x0"), meta.decimals) * meta.usdApprox;
          e.outUsd += usd;
          if (r.topic1 && protocolForAddress(r.topic1) === "offmarket") {
            e.offmarketOutUsd += usd;
          }
        } catch {
          /* malformed row — keep going */
        }
      }
    } else {
      e.ins.add(tok);
    }
  }

  const verified = verifiedSwapsByTx(db, chain);
  const byDay = new Map<string, Map<string, number>>(); // day → protocol → usd
  const add = (day: string, proto: string, usd: number) => {
    if (!(usd > 0)) return;
    let m = byDay.get(day);
    if (!m) { m = new Map(); byDay.set(day, m); }
    m.set(proto, (m.get(proto) ?? 0) + usd);
  };

  for (const [tx, e] of byTx) {
    // OFFMARKET's public comparator is trading volume, so count the funds
    // sent from the pool into its anonymizer and do not add the later return
    // deposit. A directly attributed transaction also wins over the generic
    // token-pair classifier below, keeping one transaction in one stack.
    if (e.offmarketOutUsd > 0) {
      add(e.day, "offmarket", e.offmarketOutUsd);
      continue;
    }
    const kind = classifyRoundTrip(e.outs, e.ins);
    if (kind === "lend") add(e.day, LEND_PROTOCOL, e.outUsd);
    else if (kind === "stake") add(e.day, STAKE_PROTOCOL, e.outUsd);
    else if (kind === "swap") {
      const v = verified.get(tx);
      if (!v) continue; // unverified swap — not counted
      add(e.day, (v.venue || "swap").toLowerCase(), v.usd ?? e.outUsd);
    }
  }

  if (byDay.size === 0) return { days: [], protocols: [...BASE_PROTOCOLS] };

  // Continuous daily series, first activity → today (quiet days = empty bar).
  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: RoutedVolumeDay[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const m = byDay.get(cur);
    const byProtocol: Record<string, number> = {};
    let total = 0;
    if (m) for (const [p, usd] of m) { byProtocol[p] = usd; total += usd; }
    days.push({ date: cur, total, byProtocol });
  }

  // Legend order: core venues first, then any extras (e.g. endur) that appeared.
  const present = new Set<string>();
  for (const d of days) for (const p of Object.keys(d.byProtocol)) present.add(p);
  const extras = [...present].filter((p) => !BASE_PROTOCOLS.includes(p)).sort();
  const protocols = [...BASE_PROTOCOLS, ...extras];

  return { days, protocols };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
