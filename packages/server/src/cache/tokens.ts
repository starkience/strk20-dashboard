import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface StoredTokenMeta {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

/**
 * Persistent cache of token metadata (symbol / name / decimals) fetched from
 * Starkscan. Token metadata is stable, so there's no TTL — once fetched, kept.
 */
export class TokenMetaCache {
  private readonly getStmt: StatementSync;
  private readonly putStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare(
      `SELECT symbol, name, decimals FROM token_meta WHERE address = ?`
    );
    this.putStmt = db.prepare(`
      INSERT INTO token_meta (address, symbol, name, decimals, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        decimals = excluded.decimals,
        fetched_at = excluded.fetched_at
    `);
  }

  get(address: string): StoredTokenMeta | null {
    const row = this.getStmt.get(address) as
      | { symbol: string | null; name: string | null; decimals: number | null }
      | undefined;
    if (!row) return null;
    return {
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals != null ? Number(row.decimals) : null,
    };
  }

  put(address: string, meta: StoredTokenMeta): void {
    this.putStmt.run(address, meta.symbol, meta.name, meta.decimals, Date.now());
  }
}
