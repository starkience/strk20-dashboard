import type Database from "better-sqlite3";
import type { RawContractEvent } from "@strk20/core";

export class EventCache {
  private readonly insertStmt: Database.Statement;
  private readonly countByTopicStmt: Database.Statement;
  private readonly countSinceBlockStmt: Database.Statement;
  private readonly latestBlockStmt: Database.Statement;
  private readonly upsertSyncStmt: Database.Statement;
  private readonly readSyncStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO raw_events
        (chain, contract, block_number, tx_index, log_index, tx_hash,
         timestamp_iso, topic0, topic1, topic2, topic3, data_json)
      VALUES (@chain, @contract, @blockNumber, @txIndex, @logIndex, @txHash,
              @timestampIso, @topic0, @topic1, @topic2, @topic3, @dataJson)
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
      INSERT INTO sync_state (chain, contract, last_synced_block, last_cursor, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain, contract) DO UPDATE SET
        last_synced_block = excluded.last_synced_block,
        last_cursor       = excluded.last_cursor,
        updated_at        = excluded.updated_at
    `);

    this.readSyncStmt = db.prepare(`
      SELECT last_synced_block, last_cursor, updated_at
      FROM sync_state WHERE chain = ? AND contract = ?
    `);
  }

  insertMany(chain: string, contract: string, events: RawContractEvent[]): number {
    const insert = this.db.transaction((rows: RawContractEvent[]) => {
      let inserted = 0;
      for (const e of rows) {
        const r = this.insertStmt.run({
          chain,
          contract,
          blockNumber: e.blockNumber,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          txHash: e.txHash,
          timestampIso: e.timestampIso,
          topic0: e.topic0,
          topic1: e.topic1,
          topic2: e.topic2,
          topic3: e.topic3,
          dataJson: JSON.stringify(e.data),
        });
        inserted += r.changes;
      }
      return inserted;
    });
    return insert(events);
  }

  countByTopic(chain: string, contract: string, topic0: string): number {
    const row = this.countByTopicStmt.get(chain, contract, topic0) as { n: number };
    return row?.n ?? 0;
  }

  countSinceBlock(
    chain: string,
    contract: string,
    topic0: string,
    sinceBlock: number
  ): number {
    const row = this.countSinceBlockStmt.get(
      chain,
      contract,
      topic0,
      sinceBlock
    ) as { n: number };
    return row?.n ?? 0;
  }

  latestBlock(chain: string, contract: string): number | null {
    const row = this.latestBlockStmt.get(chain, contract) as { block: number | null };
    return row?.block ?? null;
  }

  recordSyncState(
    chain: string,
    contract: string,
    lastSyncedBlock: number | null,
    lastCursor: string | null
  ): void {
    this.upsertSyncStmt.run(
      chain,
      contract,
      lastSyncedBlock,
      lastCursor,
      Date.now()
    );
  }

  readSyncState(
    chain: string,
    contract: string
  ): { lastSyncedBlock: number | null; lastCursor: string | null } | null {
    const row = this.readSyncStmt.get(chain, contract) as
      | { last_synced_block: number | null; last_cursor: string | null }
      | undefined;
    if (!row) return null;
    return {
      lastSyncedBlock: row.last_synced_block,
      lastCursor: row.last_cursor,
    };
  }
}
