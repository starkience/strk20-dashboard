import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";

/**
 * Daily TVL series reconstructed from the pool's own event stream:
 * cumulative per-token net flow (deposits − withdrawals) snapshotted at
 * each day boundary, valued at TODAY'S registry prices.
 *
 * Honest caveats, also encoded in the response:
 *   - Prices are current, not historical — the chart answers "what is
 *     the pool's historical composition worth now", which keeps the
 *     shape of accumulation visible without a historical price feed.
 *   - Unpriced tokens (vTokens…) are excluded, same as live TVL.
 *   - Protocol fees drain STRK to the collector without a Withdrawal
 *     event, so the series runs ~0.4% above the live balanceOf-based
 *     TVL by design. Counts, not custody.
 */

export interface TvlHistoryPoint {
  date: string; // YYYY-MM-DD (UTC day boundary)
  tvlUsd: number;
}

export interface TvlHistory {
  days: TvlHistoryPoint[];
  pricedAt: "current";
}

export function tvlHistory(db: Db, chain: string, pool: string): TvlHistory {
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, topic0, topic2, data_json
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?)
       ORDER BY timestamp_iso ASC`
    )
    .all(
      chain,
      pool,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.Withdrawal
    ) as { day: string; topic0: string; topic2: string | null; data_json: string }[];

  if (rows.length === 0) return { days: [], pricedAt: "current" };

  const DEP = normalizeHex(EVENT_SELECTORS.Deposit);
  // Running raw balance per token, mutated day by day.
  const net = new Map<string, bigint>();
  const days: TvlHistoryPoint[] = [];

  const valueNow = (): number => {
    let usd = 0;
    for (const [tok, raw] of net) {
      if (raw === 0n) continue;
      const meta = lookupToken(tok);
      if (!meta || meta.usdApprox <= 0) continue;
      usd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
    }
    // Pre-launch test days can net slightly negative (the pool was
    // seeded by direct transfer, which emits no Deposit event, then
    // test-withdrawn). Sub-$15 artifact — clamp for display sanity.
    return Math.max(0, usd);
  };

  let curDay = rows[0]!.day;
  for (const r of rows) {
    if (!r.topic2) continue;
    // Day rolled over: snapshot the balance for every day in between so
    // quiet days still get a (flat) point and the x-axis stays linear.
    while (r.day > curDay) {
      days.push({ date: curDay, tvlUsd: valueNow() });
      curDay = nextDay(curDay);
    }
    const tok = normalizeHex(r.topic2);
    let amount = 0n;
    try {
      const data = JSON.parse(r.data_json) as string[];
      const isDep = normalizeHex(r.topic0) === DEP;
      amount = BigInt(data[isDep ? 0 : 3] ?? "0x0");
      net.set(tok, (net.get(tok) ?? 0n) + (isDep ? amount : -amount));
    } catch {
      /* malformed row — skip */
    }
  }
  // Snapshot the final (current, possibly partial) day, then pad up to
  // today so the chart's right edge is "now".
  const today = new Date().toISOString().slice(0, 10);
  while (curDay <= today) {
    days.push({ date: curDay, tvlUsd: valueNow() });
    curDay = nextDay(curDay);
  }

  return { days, pricedAt: "current" };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
