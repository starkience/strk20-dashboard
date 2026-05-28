import type Database from "better-sqlite3";
import { EVENT_SELECTORS } from "@strk20/core";

export type AgeTier = "fresh" | "young" | "mature" | "veteran";

export interface NoteAgeBuckets {
  fresh: number; // < 1h
  young: number; // 1h – 1d
  mature: number; // 1d – 7d
  veteran: number; // > 7d
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Distribution of note ages. Buckets all `EncNoteCreated` events for v1 —
 * a more precise version would subtract `NoteUsed` notes per bucket, but
 * we don't link a nullifier back to its commitment without a proof.
 */
export function noteAgeBuckets(
  db: Database.Database,
  chain: string,
  contract: string
): NoteAgeBuckets {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT timestamp_iso FROM raw_events
       WHERE chain = ? AND contract = ? AND topic0 = ?`
    )
    .all(chain, contract, EVENT_SELECTORS.EncNoteCreated) as {
    timestamp_iso: string;
  }[];
  const buckets: NoteAgeBuckets = { fresh: 0, young: 0, mature: 0, veteran: 0 };
  for (const r of rows) {
    const ageMs = now - new Date(r.timestamp_iso).getTime();
    if (ageMs < HOUR) buckets.fresh += 1;
    else if (ageMs < DAY) buckets.young += 1;
    else if (ageMs < WEEK) buckets.mature += 1;
    else buckets.veteran += 1;
  }
  return buckets;
}
