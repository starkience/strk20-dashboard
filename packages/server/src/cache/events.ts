import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PrivacyPoolEvent, RawContractEvent } from "@strk20/core";

/**
 * What insertMany accepts: a raw log, optionally carrying Starkscan's own
 * decoding of it (the privacy-pool source supplies this, the generic
 * contract-events source does not).
 */
export type IngestableEvent = RawContractEvent | PrivacyPoolEvent;

function decoded(e: IngestableEvent): Partial<PrivacyPoolEvent> {
  return e as Partial<PrivacyPoolEvent>;
}

export class EventCache {
  private readonly insertStmt: StatementSync;
  private readonly countAllStmt: StatementSync;
  private readonly countByTopicStmt: StatementSync;
  private readonly countSinceBlockStmt: StatementSync;
  private readonly latestBlockStmt: StatementSync;
  private readonly newestEventStmt: StatementSync;
  private readonly upsertSyncStmt: StatementSync;
  private readonly readSyncStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    // Upsert rather than INSERT OR IGNORE: a row already ingested by the old
    // (undecoded) source must be able to pick up Starkscan's decoding when the
    // privacy-pool source walks past it again. COALESCE keeps it one-way —
    // decoding is only ever filled in, never overwritten with a null by a
    // source that doesn't carry it. The raw felts are immutable, so they are
    // deliberately not part of the update.
    this.insertStmt = db.prepare(`
      INSERT INTO raw_events
        (chain, contract, block_number, tx_index, log_index, tx_hash,
         timestamp_iso, topic0, topic1, topic2, topic3, data_json,
         event_name, public_fields_json, privacy_fees_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, contract, block_number, tx_index, log_index) DO UPDATE SET
        event_name         = COALESCE(excluded.event_name, raw_events.event_name),
        public_fields_json = COALESCE(excluded.public_fields_json, raw_events.public_fields_json),
        privacy_fees_json  = COALESCE(excluded.privacy_fees_json, raw_events.privacy_fees_json)
    `);

    this.countAllStmt = db.prepare(`
      SELECT COUNT(*) as n FROM raw_events WHERE chain = ? AND contract = ?
    `);

    this.countByTopicStmt = db.prepare(`
      SELECT COUNT(*) as n FROM raw_events
      WHERE chain = ? AND contract = ? AND topic0 = ?
    `);

    this.countSinceBlockStmt = db.prepare(`
      SELECT COUNT(*) as n FROM raw_events
      WHERE chain = ? AND contract = ? AND topic0 = ? AND block_number >= ?
    `);

    this.latestBlockStmt = db.prepare(`
      SELECT MAX(block_number) as block FROM raw_events
      WHERE chain = ? AND contract = ?
    `);

    this.newestEventStmt = db.prepare(`
      SELECT MAX(timestamp_iso) as iso FROM raw_events
      WHERE chain = ? AND contract = ?
    `);

    this.upsertSyncStmt = db.prepare(`
      INSERT INTO sync_state
        (chain, contract, last_synced_block, last_cursor, backfill_complete, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, contract) DO UPDATE SET
        last_synced_block = excluded.last_synced_block,
        last_cursor       = excluded.last_cursor,
        backfill_complete = excluded.backfill_complete,
        updated_at        = excluded.updated_at,
        source            = excluded.source
    `);

    this.readSyncStmt = db.prepare(`
      SELECT last_synced_block, last_cursor, backfill_complete, updated_at, source
      FROM sync_state WHERE chain = ? AND contract = ?
    `);
  }

  /**
   * Returns the number of events that were NEW, not the number of rows
   * touched: the statement upserts, so an already-known event being enriched
   * with its decoding still reports `changes: 1`. Row count before/after is
   * the only honest measure, and callers use it to decide whether a sync tick
   * did anything.
   */
  insertMany(chain: string, contract: string, events: IngestableEvent[]): number {
    if (events.length === 0) return 0;
    const before = this.countAll(chain, contract);
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        const d = decoded(e);
        this.insertStmt.run(
          chain,
          contract,
          e.blockNumber,
          e.txIndex,
          e.logIndex,
          e.txHash,
          e.timestampIso,
          e.topic0,
          e.topic1,
          e.topic2,
          e.topic3,
          JSON.stringify(e.data),
          d.eventName ?? null,
          d.publicFields != null ? JSON.stringify(d.publicFields) : null,
          d.privacyFees != null ? JSON.stringify(d.privacyFees) : null
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.countAll(chain, contract) - before;
  }

  /** Total events cached for a contract. */
  countAll(chain: string, contract: string): number {
    const row = this.countAllStmt.get(chain, contract) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  countByTopic(chain: string, contract: string, topic0: string): number {
    const row = this.countByTopicStmt.get(chain, contract, topic0) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  countSinceBlock(
    chain: string,
    contract: string,
    topic0: string,
    sinceBlock: number
  ): number {
    const row = this.countSinceBlockStmt.get(chain, contract, topic0, sinceBlock) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  latestBlock(chain: string, contract: string): number | null {
    const row = this.latestBlockStmt.get(chain, contract) as
      | { block: number | null }
      | undefined;
    return row?.block != null ? Number(row.block) : null;
  }

  /** ISO timestamp of the newest event held in the cache (the "data as of"). */
  newestEventIso(chain: string, contract: string): string | null {
    const row = this.newestEventStmt.get(chain, contract) as
      | { iso: string | null }
      | undefined;
    return row?.iso ?? null;
  }

  recordSyncState(
    chain: string,
    contract: string,
    lastSyncedBlock: number | null,
    lastCursor: string | null,
    backfillComplete: boolean,
    source: string | null = null
  ): void {
    this.upsertSyncStmt.run(
      chain,
      contract,
      lastSyncedBlock,
      lastCursor,
      backfillComplete ? 1 : 0,
      Date.now(),
      source
    );
  }

  readSyncState(
    chain: string,
    contract: string
  ): {
    lastSyncedBlock: number | null;
    lastCursor: string | null;
    backfillComplete: boolean;
    /** Wall-clock ms of the last successful sync poll (sync-loop liveness). */
    updatedAt: number | null;
    /** API route that produced lastCursor; null on rows written before sources were tracked. */
    source: string | null;
  } | null {
    const row = this.readSyncStmt.get(chain, contract) as
      | {
          last_synced_block: number | null;
          last_cursor: string | null;
          backfill_complete: number;
          updated_at: number | null;
          source: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      lastSyncedBlock: row.last_synced_block != null ? Number(row.last_synced_block) : null,
      lastCursor: row.last_cursor,
      backfillComplete: Number(row.backfill_complete) === 1,
      updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
      source: row.source ?? null,
    };
  }
}
