import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchStarkscanMarketSnapshot,
  resolveStarkscanPrice,
} from "./starkscan-market.js";

test("uses Starkscan's address-keyed quote before symbol fallbacks", async () => {
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith("/tokens")) {
      return Response.json({
        items: [
          {
            tokenAddress: "0x02ab",
            name: "Brother Eli",
            symbol: "SLAY",
            decimals: 18,
            logoUri: "https://example.test/slay.svg",
            priceUsd: 0.001113,
            source: "avnu",
            updatedAtIso: "2026-08-20T10:00:00.000Z",
          },
        ],
      });
    }
    if (url.endsWith("/strk")) return Response.json({ priceUsd: 0.03 });
    return Response.json({ priceUsd: 70_000 });
  }) as typeof fetch;

  const snapshot = await fetchStarkscanMarketSnapshot(["0x2ab", "0x02ab"], {
    baseUrl: "https://starkscan.test/api/market/",
    fetch: fetchImpl,
  });
  const price = resolveStarkscanPrice(snapshot, "0x2ab", "SLAY");

  assert.deepEqual(price, { priceUsd: 0.001113, source: "avnu" });
  const bulkCall = calls.find((call) => call.url.endsWith("/tokens"));
  assert.deepEqual(JSON.parse(bulkCall?.body ?? "{}"), { addresses: ["0x2ab"] });
});

test("matches Starkscan's stable, STRK, and BTC quote fallbacks", () => {
  const snapshot = {
    tokens: new Map(),
    strkPriceUsd: 0.025,
    btcPriceUsd: 71_500,
  };

  assert.deepEqual(resolveStarkscanPrice(snapshot, "0x1", "USDC.e"), {
    priceUsd: 1,
    source: "starkscan-stable-fallback",
  });
  assert.deepEqual(resolveStarkscanPrice(snapshot, "0x2", "STRK"), {
    priceUsd: 0.025,
    source: "starkscan-strk-fallback",
  });
  assert.deepEqual(resolveStarkscanPrice(snapshot, "0x3", "xstrkBTC"), {
    priceUsd: 71_500,
    source: "starkscan-btc-fallback",
  });
  assert.equal(resolveStarkscanPrice(snapshot, "0x4", "vSTRK"), null);
});

test("requires the bulk market response but tolerates missing reference feeds", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/tokens")) return Response.json({ items: [] });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;

  const snapshot = await fetchStarkscanMarketSnapshot(["0x1"], { fetch: fetchImpl });
  assert.equal(snapshot.strkPriceUsd, null);
  assert.equal(snapshot.btcPriceUsd, null);

  const failingFetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  await assert.rejects(
    fetchStarkscanMarketSnapshot(["0x1"], { fetch: failingFetch }),
    /Starkscan market 503/
  );
});
