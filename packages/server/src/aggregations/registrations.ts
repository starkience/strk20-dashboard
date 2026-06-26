import type { Db } from "../cache/db.js";
import { EVENT_SELECTORS } from "@strk20/core";

/**
 * User registrations per UTC day — the pool's user-growth curve.
 *
 * A user "joins" the pool by registering a viewing key (the `ViewingKeySet`
 * event), which publishes the public key relayers encrypt notes to. It fires
 * exactly once per account — the on-chain birth certificate of a pool user —
 * so counting it is the truest measure of "new users registering" (it even
 * captures wallets that registered but haven't deposited yet).
 *
 * `newUsers` is the daily registration cohort; `totalUsers` is the running
 * cumulative. We key on the FIRST `ViewingKeySet` per address (a defensive
 * MIN, in case a key is ever re-set) so each user is counted once, on the day
 * they first registered. Continuous daily series (no gaps) from the first
 * registration to today — same shape as transactionsPerDay.
 */

export interface RegistrationsDay {
  date: string; // YYYY-MM-DD (UTC)
  newUsers: number; // addresses that first registered a viewing key this day
  totalUsers: number; // cumulative registered users through this day
}

export interface Registrations {
  days: RegistrationsDay[];
  total: number; // all-time registered users (== last day's totalUsers)
}

export function registrationsPerDay(
  db: Db,
  chain: string,
  contract: string
): Registrations {
  const rows = db
    .prepare(
      `SELECT first_day AS day, COUNT(*) AS n FROM (
         SELECT topic1, substr(MIN(timestamp_iso), 1, 10) AS first_day
         FROM raw_events
         WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL
         GROUP BY topic1
       ) GROUP BY first_day`
    )
    .all(chain, contract, EVENT_SELECTORS.ViewingKeySet) as {
    day: string;
    n: number;
  }[];

  if (rows.length === 0) return { days: [], total: 0 };

  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: RegistrationsDay[] = [];
  let cumulative = 0;
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const newUsers = byDay.get(cur) ?? 0;
    cumulative += newUsers;
    days.push({ date: cur, newUsers, totalUsers: cumulative });
  }
  return { days, total: cumulative };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
