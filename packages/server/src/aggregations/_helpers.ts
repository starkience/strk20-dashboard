import type { Db } from "../cache/db.js";

/** Shared SQL helpers used by multiple aggregation modules. */

export function countByTopic(
  db: Db,
  chain: string,
  contract: string,
  topic0: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=?`
    )
    .get(chain, contract, topic0) as { n: number };
  return row?.n ?? 0;
}

export function countByTopicSinceIso(
  db: Db,
  chain: string,
  contract: string,
  topic0: string,
  sinceIso: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND timestamp_iso >= ?`
    )
    .get(chain, contract, topic0, sinceIso) as { n: number };
  return row?.n ?? 0;
}
