import type Database from "better-sqlite3";
import { EVENT_SELECTORS } from "@strk20/core";

export interface DistinctDepositors {
  count: number;
}

/** Count of distinct depositor addresses across all-time Deposit events. */
export function distinctDepositorsAllTime(
  db: Database.Database,
  chain: string,
  contract: string
): DistinctDepositors {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT topic1) as n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND topic1 IS NOT NULL`
    )
    .get(chain, contract, EVENT_SELECTORS.Deposit) as { n: number };
  return { count: row?.n ?? 0 };
}

export interface ActiveDepositors {
  count: number;
  /** Pseudonymous depositor addresses in the window. Hide from UI by default. */
  depositors: string[];
}

/** Distinct addresses that made a Deposit at or after the cutoff. */
export function activeDepositorsSince(
  db: Database.Database,
  chain: string,
  contract: string,
  sinceMs: number
): ActiveDepositors {
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT topic1 FROM raw_events
       WHERE chain = ? AND contract = ? AND topic0 = ? AND timestamp_iso >= ?`
    )
    .all(chain, contract, EVENT_SELECTORS.Deposit, sinceIso) as {
    topic1: string;
  }[];
  const depositors = rows.map((r) => r.topic1.toLowerCase());
  return { count: depositors.length, depositors };
}
