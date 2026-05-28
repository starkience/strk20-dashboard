import type Database from "better-sqlite3";

/** Generic key/value cache with TTL for view-function results. */
export class ViewCache {
  private readonly getStmt: Database.Statement;
  private readonly putStmt: Database.Statement;
  private readonly purgeStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare(`
      SELECT value_json, expires_at FROM view_cache WHERE key = ?
    `);
    this.putStmt = db.prepare(`
      INSERT INTO view_cache (key, value_json, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        expires_at = excluded.expires_at
    `);
    this.purgeStmt = db.prepare(`
      DELETE FROM view_cache WHERE expires_at < ?
    `);
  }

  get<T>(key: string): T | null {
    const row = this.getStmt.get(key) as
      | { value_json: string; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    return JSON.parse(row.value_json) as T;
  }

  put<T>(key: string, value: T, ttlMs: number): void {
    this.putStmt.run(key, JSON.stringify(value), Date.now() + ttlMs);
  }

  purgeExpired(): number {
    return this.purgeStmt.run(Date.now()).changes;
  }
}
