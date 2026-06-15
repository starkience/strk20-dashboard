import type { Db } from "../cache/db.js";

/**
 * Pool transactions per UTC day — distinct tx hashes in the event cache
 * (each pool tx = one apply_actions call). Single-series daily bar chart.
 */

export interface TransactionsDay {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface Transactions {
  days: TransactionsDay[];
  total: number;
}

export function transactionsPerDay(db: Db, chain: string, pool: string): Transactions {
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, COUNT(DISTINCT tx_hash) AS n
       FROM raw_events WHERE chain=? AND contract=? GROUP BY day`
    )
    .all(chain, pool) as { day: string; n: number }[];

  if (rows.length === 0) return { days: [], total: 0 };

  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: TransactionsDay[] = [];
  let total = 0;
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const count = byDay.get(cur) ?? 0;
    days.push({ date: cur, count });
    total += count;
  }
  return { days, total };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
