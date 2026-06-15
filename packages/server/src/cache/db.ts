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

CREATE TABLE IF NOT EXISTS token_prices (
  address     TEXT PRIMARY KEY,
  usd         REAL NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Receipt-verification bookkeeping: every round-trip candidate tx gets
-- exactly one receipt fetch (receipts are immutable), recorded here so
-- the venue-verify service never refetches.
CREATE TABLE IF NOT EXISTS tx_venue_checks (
  chain        TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  checked_at   INTEGER NOT NULL,
  swaps_found  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, tx_hash)
);

-- Venue-emitted swaps decoded from those receipts (AVNU Swap events,
-- Ekubo Swapped presence). Amounts are raw integer strings; null amount
-- columns mean the venue event was seen but its ABI isn't decoded.
CREATE TABLE IF NOT EXISTS venue_swaps (
  chain        TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  evt_index    INTEGER NOT NULL,
  day          TEXT NOT NULL,
  venue        TEXT NOT NULL,
  sell_token   TEXT,
  sell_amount  TEXT,
  buy_token    TEXT,
  buy_amount   TEXT,
  PRIMARY KEY (chain, tx_hash, evt_index)
);

CREATE INDEX IF NOT EXISTS idx_venue_swaps_day
  ON venue_swaps(chain, day);

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
