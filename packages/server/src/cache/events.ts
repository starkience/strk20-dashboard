import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { RawContractEvent } from "@strk20/core";

export class EventCache {
  private readonly insertStmt: StatementSync;
  private readonly countByTopicStmt: StatementSync;
  private readonly countSinceBlockStmt: StatementSync;
  private readonly latestBlockStmt: StatementSync;
  private readonly upsertSyncStmt: StatementSync;
  private readonly readSyncStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO raw_events
        (chain, contract, block_number, tx_index, log_index, tx_hash,
         timestamp_iso, topic0, topic1, topic2, topic3, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    this.upsertSyncStmt = db.prepare(`
      INSERT INTO sync_state
        (chain, contract, last_synced_block, last_cursor, backfill_complete, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain, contract) DO UPDATE SET
        last_synced_block = excluded.last_synced_block,
        last_cursor       = excluded.last_cursor,
        backfill_complete = excluded.backfill_complete,
        updated_at        = excluded.updated_at
    `);

    this.readSyncStmt = db.prepare(`
      SELECT last_synced_block, last_cursor, backfill_complete, updated_at
      FROM sync_state WHERE chain = ? AND contract = ?
    `);
  }

  insertMany(chain: string, contract: string, events: RawContractEvent[]): number {
    if (events.length === 0) return 0;
    this.db.exec("BEGIN");
    let inserted = 0;
    try {
      for (const e of events) {
        const r = this.insertStmt.run(
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
          JSON.stringify(e.data)
        );
        inserted += Number(r.changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
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

  recordSyncState(
    chain: string,
    contract: string,
    lastSyncedBlock: number | null,
    lastCursor: string | null,
    backfillComplete: boolean
  ): void {
    this.upsertSyncStmt.run(
      chain,
      contract,
      lastSyncedBlock,
      lastCursor,
      backfillComplete ? 1 : 0,
      Date.now()
    );
  }

  readSyncState(
    chain: string,
    contract: string
  ): {
    lastSyncedBlock: number | null;
    lastCursor: string | null;
    backfillComplete: boolean;
  } | null {
    const row = this.readSyncStmt.get(chain, contract) as
      | {
          last_synced_block: number | null;
          last_cursor: string | null;
          backfill_complete: number;
        }
      | undefined;
    if (!row) return null;
    return {
      lastSyncedBlock: row.last_synced_block != null ? Number(row.last_synced_block) : null,
      lastCursor: row.last_cursor,
      backfillComplete: Number(row.backfill_complete) === 1,
    };
  }
}
