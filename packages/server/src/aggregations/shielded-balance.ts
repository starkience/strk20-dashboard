import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";

/**
 * Per-token shielded balance, daily — the breakdown behind tvl-history.
 *
 * Same reconstruction as tvl-history (cumulative per-token net flow:
 * Deposit + OpenNoteDeposited inflows − Withdrawal outflows, snapshotted at
 * each UTC day boundary, valued at TODAY'S registry prices) — but instead of
 * collapsing the per-token map to one number, it emits the map. By
 * construction, sum(byToken) on any day equals that day's tvl-history tvlUsd,
 * so the stacked-bar chart and the TVL line always agree.
 *
 * Same honest caveats as tvl-history: current prices (not historical),
 * unpriced tokens excluded, counts-not-custody (~0.4% above live balanceOf).
 */

export interface ShieldedBalanceDay {
  date: string; // YYYY-MM-DD (UTC)
  total: number; // USD, == sum of byToken values
  /** symbol → USD, nonzero priced tokens only. */
  byToken: Record<string, number>;
}

export interface ShieldedBalance {
  days: ShieldedBalanceDay[];
  /** Symbols ordered by latest-day USD desc — stable stack + legend order. */
  tokens: string[];
  pricedAt: "current";
}

export function shieldedBalance(db: Db, chain: string, pool: string): ShieldedBalance {
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, topic0, topic2, data_json
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
    ) as { day: string; topic0: string; topic2: string | null; data_json: string }[];

  if (rows.length === 0) return { days: [], tokens: [], pricedAt: "current" };

  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);
  const net = new Map<string, bigint>(); // token address → running raw balance
  const days: ShieldedBalanceDay[] = [];

  const snapshot = (date: string): ShieldedBalanceDay => {
    const byToken: Record<string, number> = {};
    let total = 0;
    for (const [tok, raw] of net) {
      if (raw <= 0n) continue; // skip zero/negative (sub-$15 launch artifacts)
      const meta = lookupToken(tok);
      if (!meta || meta.usdApprox <= 0) continue; // unpriced → excluded, as in TVL
      const usd = applyDecimals(raw, meta.decimals) * meta.usdApprox;
      if (usd <= 0) continue;
      const sym = meta.symbol || shortAddr(tok);
      byToken[sym] = (byToken[sym] ?? 0) + usd;
      total += usd;
    }
    return { date, total, byToken };
  };

  let curDay = rows[0]!.day;
  for (const r of rows) {
    if (!r.topic2) continue;
    // Fill quiet days with a flat snapshot so the x-axis stays linear.
    while (r.day > curDay) {
      days.push(snapshot(curDay));
      curDay = nextDay(curDay);
    }
    const tok = normalizeHex(r.topic2);
    try {
      const data = JSON.parse(r.data_json) as string[];
      const isOut = normalizeHex(r.topic0) === WD;
      const amount = BigInt(data[isOut ? 3 : 0] ?? "0x0");
      net.set(tok, (net.get(tok) ?? 0n) + (isOut ? -amount : amount));
    } catch {
      /* malformed row — skip */
    }
  }
  // Final (partial) day, then pad to today so the right edge is "now".
  const today = new Date().toISOString().slice(0, 10);
  while (curDay <= today) {
    days.push(snapshot(curDay));
    curDay = nextDay(curDay);
  }

  // Legend / stack order: by the most recent day's value, descending; append
  // any token that appeared earlier but not on the last day.
  const last = days.length ? days[days.length - 1]!.byToken : {};
  const tokens = Object.keys(last).sort((a, b) => (last[b] ?? 0) - (last[a] ?? 0));
  const seen = new Set(tokens);
  for (const d of days) {
    for (const sym of Object.keys(d.byToken)) {
      if (!seen.has(sym)) {
        seen.add(sym);
        tokens.push(sym);
      }
    }
  }

  return { days, tokens, pricedAt: "current" };
}

function shortAddr(address: string): string {
  const s = address.toLowerCase();
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
