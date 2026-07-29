import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "./db.js";

/** The venue_swaps shape deployed before trade-time pricing existed. */
const LEGACY_SCHEMA = `
CREATE TABLE venue_swaps (
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
`;

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test("adds the trade-time price columns to an already-deployed venue_swaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "strk20-db-"));
  const path = join(dir, "cache.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(
        `INSERT INTO venue_swaps
           (chain, tx_hash, evt_index, day, venue, sell_token, sell_amount, buy_token, buy_amount)
         VALUES ('SN_MAIN', '0xold', 0, '2026-07-01', 'avnu', '0xtok', '1000', NULL, NULL)`
      )
      .run();
    assert.ok(!columns(legacy, "venue_swaps").includes("sell_usd"), "precondition: no sell_usd");
    legacy.close();

    const db = openCache(path);
    const cols = columns(db, "venue_swaps");
    assert.ok(cols.includes("sell_usd"), "sell_usd added");
    assert.ok(cols.includes("buy_usd"), "buy_usd added");

    // The existing row survives, with the new columns empty.
    const row = db
      .prepare(`SELECT tx_hash, sell_amount, sell_usd FROM venue_swaps`)
      .get() as { tx_hash: string; sell_amount: string; sell_usd: number | null };
    assert.equal(row.tx_hash, "0xold");
    assert.equal(row.sell_amount, "1000");
    assert.equal(row.sell_usd, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-opening an already-migrated database is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "strk20-db-"));
  const path = join(dir, "cache.db");
  try {
    openCache(path).close();
    const db = openCache(path);
    const cols = columns(db, "venue_swaps");
    assert.equal(cols.filter((c) => c === "sell_usd").length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
