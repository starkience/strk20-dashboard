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
 * `activeUsers` is the day's distinct depositor count. `total` is the all-time
 * distinct depositor count across the whole range (NOT a sum of the daily
 * counts, which would double-count anyone active on multiple days). Continuous
 * daily series (no gaps) from the first deposit to today — same shape as
 * registrationsPerDay.
 */

export interface ActiveUsersDay {
  date: string; // YYYY-MM-DD (UTC)
  activeUsers: number; // distinct addresses that shielded this day
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
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, COUNT(DISTINCT topic1) AS n
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL
       GROUP BY day`
    )
    .all(chain, contract, EVENT_SELECTORS.Deposit) as {
    day: string;
    n: number;
  }[];

  if (rows.length === 0) return { days: [], total: 0 };

  const totalRow = db
    .prepare(
      `SELECT COUNT(DISTINCT topic1) AS n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL`
    )
    .get(chain, contract, EVENT_SELECTORS.Deposit) as { n: number };

  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: ActiveUsersDay[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    days.push({ date: cur, activeUsers: byDay.get(cur) ?? 0 });
  }
  return { days, total: Number(totalRow?.n ?? 0) };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
