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
  -- Starkscan's own decoding of the log, carried alongside the raw felts by
  -- the privacy-pool sync source. NULL on rows ingested before the switch
  -- (and on any row the API returns undecoded), so every reader must treat
  -- these as optional and keep its topic0/data path as the fallback.
  event_name          TEXT,
  public_fields_json  TEXT,
  privacy_fees_json   TEXT,
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
  -- Which API route produced last_cursor. Cursors are opaque and scoped to
  -- their route, so a stored cursor is only resumable by the same source;
  -- changing source must drop it rather than replay it somewhere else.
  source             TEXT,
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
--
-- sell_usd / buy_usd freeze each leg's USD value at the moment the swap
-- was RECORDED. Without them every read re-priced the whole history at
-- today's spot, so a 30D volume figure drifted with token price even on
-- zero-swap days (and was never comparable to venue-reported volume,
-- which is priced at trade time). Null = the token had no price then;
-- readers fall back to the current price so the row still counts.
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
  sell_usd     REAL,
  buy_usd      REAL,
  PRIMARY KEY (chain, tx_hash, evt_index)
);

CREATE INDEX IF NOT EXISTS idx_venue_swaps_day
  ON venue_swaps(chain, day);

-- Depositor wallet → account class hash (starknet_getClassHashAt), swept by
-- the wallet-classify service. class_hash NULL = address not deployed (a
-- deposit can name a counterfactual address). Class hashes only change on
-- account upgrade, so one fetch per address is enough; re-sweeps only fill
-- gaps.
CREATE TABLE IF NOT EXISTS wallet_classes (
  chain       TEXT NOT NULL,
  address     TEXT NOT NULL,
  class_hash  TEXT,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS view_cache (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_view_cache_expires
  ON view_cache(expires_at);
`;

/**
 * Columns added to tables that already exist in deployed databases.
 * `CREATE TABLE IF NOT EXISTS` is a no-op there, so new columns need an
 * explicit ALTER. Each entry is applied only when absent, making this
 * safe to run on every boot.
 */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "venue_swaps", column: "sell_usd", type: "REAL" },
  { table: "venue_swaps", column: "buy_usd", type: "REAL" },
  { table: "raw_events", column: "event_name", type: "TEXT" },
  { table: "raw_events", column: "public_fields_json", type: "TEXT" },
  { table: "raw_events", column: "privacy_fees_json", type: "TEXT" },
  { table: "sync_state", column: "source", type: "TEXT" },
];

function applyColumnMigrations(db: DatabaseSync): void {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openCache(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  applyColumnMigrations(db);
  return db;
}
