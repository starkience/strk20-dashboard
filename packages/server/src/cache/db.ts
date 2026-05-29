import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Uses Node's built-in SQLite (node:sqlite, stable file format, ships with
 * Node 22+). No native build step — drops the better-sqlite3 toolchain
 * requirement entirely. `node:sqlite` is still flagged experimental; we pin
 * Node 24 in .nvmrc.
 */
export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_events (
  chain          TEXT NOT NULL,
  contract       TEXT NOT NULL,
  block_number   INTEGER NOT NULL,
  tx_index       INTEGER NOT NULL,
  log_index      INTEGER NOT NULL,
  tx_hash        TEXT NOT NULL,
  timestamp_iso  TEXT NOT NULL,
  topic0         TEXT NOT NULL,
  topic1         TEXT,
  topic2         TEXT,
  topic3         TEXT,
  data_json      TEXT NOT NULL,
  PRIMARY KEY (chain, contract, block_number, tx_index, log_index)
);

CREATE INDEX IF NOT EXISTS idx_raw_events_topic0
  ON raw_events(chain, contract, topic0);

CREATE INDEX IF NOT EXISTS idx_raw_events_block
  ON raw_events(chain, contract, block_number);

CREATE TABLE IF NOT EXISTS sync_state (
  chain              TEXT NOT NULL,
  contract           TEXT NOT NULL,
  last_synced_block  INTEGER,
  last_cursor        TEXT,
  backfill_complete  INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (chain, contract)
);

CREATE TABLE IF NOT EXISTS token_meta (
  address     TEXT PRIMARY KEY,
  symbol      TEXT,
  name        TEXT,
  decimals    INTEGER,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS view_cache (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_view_cache_expires
  ON view_cache(expires_at);
`;

export function openCache(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  return db;
}
