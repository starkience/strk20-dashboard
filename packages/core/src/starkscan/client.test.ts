import { test } from "node:test";
import assert from "node:assert/strict";
import { StarkscanClient } from "./client.js";

/** A fetch stub that answers with canned bodies + rate-limit headers. */
function stubFetch(
  reply: (url: string) => { body: unknown; policy?: string; remaining?: string; limit?: string }
) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const r = reply(String(url));
    const headers = new Headers({ "Content-Type": "application/json" });
    if (r.policy) headers.set("X-Ratelimit-Policy", r.policy);
    if (r.remaining) headers.set("X-Ratelimit-Remaining", r.remaining);
    if (r.limit) headers.set("X-Ratelimit-Limit", r.limit);
    return new Response(JSON.stringify(r.body), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch) {
  return new StarkscanClient({
    baseUrl: "https://api.test",
    apiKey: "k",
    chain: "SN_MAIN",
    fetch: fetchImpl,
  });
}

const POOL_EVENT = {
  blockNumber: 100,
  timestampIso: "2026-08-11T00:00:00.000Z",
  txHash: "0xtx",
  txIndex: 2,
  logIndex: 13,
  contractAddress: "0x40337b",
  topic0: "0xt0",
  keys: ["0xt0", "0xt1", "0xt2"],
  data: ["0xd0", "0xd1"],
  eventName: "withdrawal",
  publicFields: { visibility: "partial", amountRaw: "6000000000000000000" },
  privacyFees: [{ tokenAddress: "0xstrk", amountRaw: "6000000000000000000" }],
};

test("privacy-pool events map keys[] back onto topic0..topic3", async () => {
  const { impl } = stubFetch(() => ({ body: { items: [POOL_EVENT], nextCursor: "c1" } }));
  const page = await client(impl).privacyPoolEvents({ limit: 1 });

  const e = page.items[0]!;
  assert.equal(e.topic0, "0xt0");
  assert.equal(e.topic1, "0xt1");
  assert.equal(e.topic2, "0xt2");
  assert.equal(e.topic3, null, "the pool never declares a fourth key");
  assert.equal(e.address, "0x40337b", "contractAddress becomes address");
  assert.deepEqual(e.data, ["0xd0", "0xd1"]);
  assert.equal(page.nextCursor, "c1");
});

test("privacy-pool events carry Starkscan's decoding through", async () => {
  const { impl } = stubFetch(() => ({ body: { items: [POOL_EVENT], nextCursor: null } }));
  const e = (await client(impl).privacyPoolEvents()).items[0]!;
  assert.equal(e.eventName, "withdrawal");
  assert.equal(e.publicFields?.visibility, "partial");
  assert.equal(e.privacyFees?.[0]?.amountRaw, "6000000000000000000");
});

test("an item with no decoding yields nulls, not undefined", async () => {
  const bare = { ...POOL_EVENT } as Record<string, unknown>;
  delete bare.eventName;
  delete bare.publicFields;
  delete bare.privacyFees;
  const { impl } = stubFetch(() => ({ body: { items: [bare], nextCursor: null } }));
  const e = (await client(impl).privacyPoolEvents()).items[0]!;
  assert.equal(e.eventName, null);
  assert.equal(e.publicFields, null);
  assert.equal(e.privacyFees, null);
});

test("a light bucket with headroom does not wave through an exhausted heavy one", async () => {
  // The privacy-pool route bills to `heavy`, everything else to `light`.
  // A light response reporting 500 remaining must not cancel the heavy
  // route's throttle — they are separate buckets.
  const { impl, calls } = stubFetch((url) =>
    url.includes("/privacy-pool/")
      ? { body: { items: [], nextCursor: null }, policy: "heavy;w=60", remaining: "1", limit: "240" }
      : { body: { headBlockNumber: 1 }, policy: "light;w=60", remaining: "500", limit: "600" }
  );
  const c = client(impl);

  await c.privacyPoolEvents(); // heavy bucket now reports 1 remaining
  await c.status(); // light bucket, plenty left — must not clear the heavy state

  const started = Date.now();
  await c.privacyPoolEvents();
  const waited = Date.now() - started;

  assert.equal(calls.length, 3);
  assert.ok(waited >= 4_000, `expected the heavy-bucket backoff, waited ${waited}ms`);
});

test("a route billed to a healthy bucket is not slowed by another route's exhaustion", async () => {
  const { impl } = stubFetch((url) =>
    url.includes("/privacy-pool/")
      ? { body: { items: [], nextCursor: null }, policy: "heavy;w=60", remaining: "1", limit: "240" }
      : { body: { headBlockNumber: 1 }, policy: "light;w=60", remaining: "500", limit: "600" }
  );
  const c = client(impl);

  await c.privacyPoolEvents();
  const started = Date.now();
  await c.status();
  assert.ok(Date.now() - started < 1_000, "the light route should not pay the heavy route's backoff");
});
