import type { Db } from "../cache/db.js";
import { EVENT_SELECTORS } from "@strk20/core";

/**
 * Daily active users — distinct depositor addresses that shielded each UTC day.
 *
 * A `Deposit` publishes the depositor's wallet in `topic1` — the SAME identifier
 * `ViewingKeySet` keys on — so a distinct count per day is "registered
 * viewing-key holders who shielded that day". It is the only observable activity
 * signal: withdrawals go to fresh addresses and internal note spends (`NoteUsed`)
 * carry no owner, so privacy hides them by design. This is therefore daily active
 * *shielders*, not all-activity — the right engagement metric for a shielding
 * campaign.
 *
 * `activeUsers` is the day's distinct depositor count (DAU). `wau`/`mau` are
 * rolling windows ending that day: distinct depositors over the trailing 7 and
 * 30 days — NOT sums of the daily counts (that would double-count anyone
 * active on multiple days). `total` is the all-time distinct depositor count.
 * Continuous daily series (no gaps) from the first deposit to today — same
 * shape as registrationsPerDay.
 */

export interface ActiveUsersDay {
  date: string; // YYYY-MM-DD (UTC)
  activeUsers: number; // distinct addresses that shielded this day (DAU)
  wau: number; // distinct addresses over the trailing 7 days ending this day
  mau: number; // distinct addresses over the trailing 30 days ending this day
}

export interface ActiveUsers {
  days: ActiveUsersDay[];
  total: number; // all-time distinct active depositors (de-duplicated, not summed)
}

export function activeUsersPerDay(
  db: Db,
  chain: string,
  contract: string
): ActiveUsers {
  // (day, address) pairs — the rolling windows need WHO was active each day,
  // not just how many, so distinct counts across windows don't double-count.
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(timestamp_iso, 1, 10) AS day, topic1 AS addr
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL`
    )
    .all(chain, contract, EVENT_SELECTORS.Deposit) as {
    day: string;
    addr: string;
  }[];

  if (rows.length === 0) return { days: [], total: 0 };

  const totalRow = db
    .prepare(
      `SELECT COUNT(DISTINCT topic1) AS n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL`
    )
    .get(chain, contract, EVENT_SELECTORS.Deposit) as { n: number };

  const byDay = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = byDay.get(r.day);
    if (!s) { s = new Set(); byDay.set(r.day, s); }
    s.add(r.addr);
  }

  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);

  // Continuous day list first, so the rolling windows slide over real
  // calendar days (a quiet day still ages old actives out of the window).
  const dates: string[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) dates.push(cur);

  const distinctOver = (slice: string[]): number => {
    const s = new Set<string>();
    for (const day of slice) {
      const users = byDay.get(day);
      if (users) for (const u of users) s.add(u);
    }
    return s.size;
  };

  const days: ActiveUsersDay[] = dates.map((date, i) => ({
    date,
    activeUsers: byDay.get(date)?.size ?? 0,
    wau: distinctOver(dates.slice(Math.max(0, i - 6), i + 1)),
    mau: distinctOver(dates.slice(Math.max(0, i - 29), i + 1)),
  }));

  return { days, total: Number(totalRow?.n ?? 0) };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
