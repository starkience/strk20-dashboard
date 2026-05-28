import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (chain, contract)
);

CREATE TABLE IF NOT EXISTS view_cache (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_view_cache_expires
  ON view_cache(expires_at);
`;

export function openCache(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}
