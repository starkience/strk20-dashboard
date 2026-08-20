import type { Db } from "./db.js";

/**
 * Indexer sync heartbeats — one row per Starkscan poll attempt.
 *
 * The sync loop records ok=true after a successful poll (with the count
 * of events inserted) and ok=false when an error bubbles up. The uptime
 * aggregation buckets these per day to derive ok / degraded / incident
 * status for the 90-day chart.
 *
 * When Uptime Kuma is deployed and pointed at the server's /health
 * endpoint, swap uptimeHistory()'s data source to Kuma's status-page
 * API; this table is the local fallback / dev source.
 */

export interface HeartbeatRow {
  ts: number;
  ok: 0 | 1;
  events_inserted: number;
  error_message: string | null;
}

export class HeartbeatCache {
  constructor(private db: Db) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_heartbeats (
        ts INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        events_inserted INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON sync_heartbeats(ts)`
    );
  }

  record(ok: boolean, eventsInserted: number, errorMessage?: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_heartbeats (ts, ok, events_inserted, error_message)
         VALUES (?, ?, ?, ?)`
      )
      .run(Date.now(), ok ? 1 : 0, eventsInserted, errorMessage ?? null);
  }

  /** Heartbeats since `fromMs` (inclusive), ordered ascending by ts. */
  since(fromMs: number): HeartbeatRow[] {
    return this.db
      .prepare(
        `SELECT ts, ok, events_inserted, error_message
           FROM sync_heartbeats
          WHERE ts >= ?
          ORDER BY ts ASC`
      )
      .all(fromMs) as unknown as HeartbeatRow[];
  }
}
