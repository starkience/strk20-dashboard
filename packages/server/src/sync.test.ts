import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarkscanClient } from "@strk20/core";
import { openCache } from "./cache/db.js";
import { EventCache } from "./cache/events.js";
import { SYNC_SOURCE, syncContractEvents } from "./sync.js";

const CHAIN = "SN_MAIN";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const OTHER_POOL = "0x0999999999999999999999999999999999999999999999999999999999999999";

/** One /privacy-pool/events item, in the shape the client hands back. */
function event(
  n: number,
  over: Partial<{ address: string; eventName: string | null; publicFields: unknown; privacyFees: unknown[] | null }> = {}
) {
  return {
    blockNumber: n,
    timestampIso: `2026-08-11T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
    txHash: `0xtx${n}`,
    txIndex: 0,
    logIndex: 0,
    address: over.address ?? POOL,
    topic0: "0xdeadbeef",
    topic1: "0xuser",
    topic2: null,
    topic3: null,
    data: [`0x${n.toString(16)}`],
    eventName: over.eventName === undefined ? "deposit" : over.eventName,
    publicFields: (over.publicFields === undefined
      ? { visibility: "partial", amountRaw: "1000" }
      : over.publicFields) as never,
    privacyFees: (over.privacyFees === undefined ? [{ amountRaw: "6" }] : over.privacyFees) as never,
  };
}

/**
 * A client that serves canned pages and records what it was asked for, so a
 * test can assert on the cursors the sync actually walked.
 */
function fakeClient(pages: { items: ReturnType<typeof event>[]; nextCursor: string | null }[]) {
  const asked: (string | null)[] = [];
  let i = 0;
  const client = {
    async privacyPoolEvents(opts: { limit?: number; cursor?: string | null } = {}) {
      asked.push(opts.cursor ?? null);
      return pages[i++] ?? { items: [], nextCursor: null };
    },
  } as unknown as StarkscanClient;
  return { client, asked };
}

function withCache(fn: (cache: EventCache) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "strk20-sync-"));
  const db = openCache(join(dir, "cache.db"));
  return Promise.resolve(fn(new EventCache(db))).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function rows(cache: EventCache) {
  // EventCache owns no generic read; go through its counters instead.
  return cache.countAll(CHAIN, POOL);
}

test("backfill stores Starkscan's decoding alongside the raw felts", async () => {
  await withCache(async (cache) => {
    const { client } = fakeClient([{ items: [event(100)], nextCursor: null }]);
    const res = await syncContractEvents(client, cache, CHAIN, POOL);

    assert.equal(res.phase, "backfill");
    assert.equal(res.eventsInserted, 1);
    assert.equal(res.backfillComplete, true);

    const db = (cache as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const row = db
      .prepare(`SELECT event_name, public_fields_json, privacy_fees_json FROM raw_events`)
      .get() as { event_name: string; public_fields_json: string; privacy_fees_json: string };
    assert.equal(row.event_name, "deposit");
    assert.equal(JSON.parse(row.public_fields_json).visibility, "partial");
    assert.equal(JSON.parse(row.privacy_fees_json)[0].amountRaw, "6");
  });
});

test("events from another pool contract never enter this pool's cache", async () => {
  await withCache(async (cache) => {
    const { client } = fakeClient([
      { items: [event(100), event(99, { address: OTHER_POOL })], nextCursor: null },
    ]);
    const res = await syncContractEvents(client, cache, CHAIN, POOL);
    assert.equal(res.eventsInserted, 1);
    assert.equal(rows(cache), 1);
  });
});

test("a page holding only other pools' events still advances the walk", async () => {
  await withCache(async (cache) => {
    const { client, asked } = fakeClient([
      { items: [event(200, { address: OTHER_POOL })], nextCursor: "c1" },
      { items: [event(100)], nextCursor: null },
    ]);
    await syncContractEvents(client, cache, CHAIN, POOL);
    // The cursor came from the unfiltered page, so the second call resumes
    // where the feed actually was — nothing between the two pages is skipped.
    assert.deepEqual(asked, [null, "c1"]);
    assert.equal(rows(cache), 1);
  });
});

test("a cursor left by the old contract-events source is not replayed here", async () => {
  await withCache(async (cache) => {
    // Deployed state: backfill done by the previous source, mid-descent cursor.
    cache.recordSyncState(CHAIN, POOL, 500, "legacy-cursor", true, "contract-events");
    const { client, asked } = fakeClient([{ items: [event(600)], nextCursor: null }]);
    await syncContractEvents(client, cache, CHAIN, POOL);
    assert.deepEqual(asked, [null], "restarted at the head instead of resuming a foreign cursor");
    assert.equal(cache.readSyncState(CHAIN, POOL)?.source, SYNC_SOURCE);
  });
});

test("its own cursor IS resumed, so a long descent finishes over several ticks", async () => {
  await withCache(async (cache) => {
    cache.recordSyncState(CHAIN, POOL, 500, "mine-c2", true, SYNC_SOURCE);
    const { client, asked } = fakeClient([{ items: [event(400)], nextCursor: null }]);
    await syncContractEvents(client, cache, CHAIN, POOL);
    assert.deepEqual(asked, ["mine-c2"]);
  });
});

test("re-walking an event ingested before the switch fills in its decoding", async () => {
  await withCache(async (cache) => {
    // A row as the old source wrote it: raw felts only.
    cache.insertMany(CHAIN, POOL, [
      {
        blockNumber: 100,
        timestampIso: "2026-08-11T00:00:00.000Z",
        txHash: "0xtx100",
        txIndex: 0,
        logIndex: 0,
        address: POOL,
        topic0: "0xdeadbeef",
        topic1: "0xuser",
        topic2: null,
        topic3: null,
        data: ["0x64"],
      },
    ]);
    const db = (cache as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    assert.equal(
      (db.prepare(`SELECT event_name FROM raw_events`).get() as { event_name: string | null }).event_name,
      null
    );

    const { client } = fakeClient([{ items: [event(100)], nextCursor: null }]);
    const res = await syncContractEvents(client, cache, CHAIN, POOL);

    // Nothing new arrived — the tick must not claim an insert for an upsert.
    assert.equal(res.eventsInserted, 0);
    assert.equal(rows(cache), 1);
    assert.equal(
      (db.prepare(`SELECT event_name FROM raw_events`).get() as { event_name: string }).event_name,
      "deposit"
    );
  });
});

test("a source that carries no decoding cannot blank out decoding already stored", async () => {
  await withCache(async (cache) => {
    cache.insertMany(CHAIN, POOL, [event(100)]);
    // The same log re-ingested by a plain contract-events read.
    const { eventName, publicFields, privacyFees, ...raw } = event(100);
    void eventName;
    void publicFields;
    void privacyFees;
    cache.insertMany(CHAIN, POOL, [raw]);
    const db = (cache as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const row = db.prepare(`SELECT event_name FROM raw_events`).get() as { event_name: string };
    assert.equal(row.event_name, "deposit");
  });
});

test("catch-up stops once it bridges down into covered blocks", async () => {
  await withCache(async (cache) => {
    cache.insertMany(CHAIN, POOL, [event(500)]);
    cache.recordSyncState(CHAIN, POOL, 500, null, true, SYNC_SOURCE);

    const { client, asked } = fakeClient([
      { items: [event(700)], nextCursor: "c1" },
      { items: [event(500)], nextCursor: "c2" }, // reaches the anchor
      { items: [event(300)], nextCursor: "c3" }, // must never be fetched
    ]);
    const res = await syncContractEvents(client, cache, CHAIN, POOL);

    assert.equal(res.phase, "catchup");
    assert.equal(res.eventsInserted, 1, "only block 700 was new");
    assert.deepEqual(asked, [null, "c1"]);
    // Caught up: the cursor is cleared so the next tick starts at the head.
    assert.equal(cache.readSyncState(CHAIN, POOL)?.lastCursor, null);
  });
});
