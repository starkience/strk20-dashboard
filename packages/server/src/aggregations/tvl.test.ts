import { test } from "node:test";
import assert from "node:assert/strict";
import { AvnuTokenIndex, StarkscanClient, type PrivacyPoolTvlResponse } from "@strk20/core";
import { openCache } from "../cache/db.js";
import { TokenMetaCache } from "../cache/tokens.js";
import { ViewCache } from "../cache/view.js";
import { currentTvl, valueStarkscanSnapshot } from "./tvl.js";

const SLAY = "0x2ab";
const USDC = "0x330";

test("uses Starkscan prepared valuations instead of a separate market price feed", async () => {
  const snapshot: PrivacyPoolTvlResponse = {
    schemaVersion: "1",
    chainId: "SN_MAIN",
    scope: "strk20_privacy_pool",
    accountingMethod: "finalized_public_flow_ledger_v1",
    status: "complete",
    asOf: {
      blockNumber: 123,
      blockHash: "0xabc",
      blockTimestamp: "2026-08-20T10:00:00.000Z",
      materializedAt: "2026-08-20T10:00:01.000Z",
    },
    coverage: {
      status: "complete",
      reasonCode: "finalized_public_flow_ledger",
      finalizedOnly: true,
      finalityBasis: "starkscan_indexed_finalized_tier",
      latestL1AcceptedBlockNumber: 120,
      asOfL1Accepted: false,
      fromBlockNumber: 1,
      throughBlockNumber: 123,
      latestEventBlockNumber: 122,
      latestEventCursor: "122:1:0",
      poolContractCount: 1,
      tokenCount: 2,
      missingAmountEventCount: 0,
      decodedMaterializationFresh: true,
      decodedEventLagBlocks: 0,
    },
    assets: [
      asset(SLAY, "SLAY", 18, "27000000000000000000000000"),
      asset(USDC, "USDC", 6, "100000000"),
    ],
    caveat: "finalized public flow",
  };
  const client = new StarkscanClient({
    baseUrl: "https://api.starkscan.test",
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async () => Response.json(snapshot)) as typeof fetch,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.ok(String(input).endsWith("/privacy-pool/tvl"), "only the authoritative snapshot is fetched");
    return Response.json(snapshot);
  }) as typeof fetch;

  const db = openCache(":memory:");
  try {
    const result = await currentTvl(
      client,
      db,
      new ViewCache(db),
      new TokenMetaCache(db),
      new AvnuTokenIndex(),
      "SN_MAIN",
      "0xpool"
    );

    assert.equal(result.tvlSource, "starkscan-finalized");
    assert.equal(result.tvlAsOfBlock, 123);
    assert.equal(result.totalUsd, 27_098);
    assert.equal(result.partial, false);
    assert.equal(result.unpricedTokenCount, 0);
    assert.equal(result.priceCoverageComplete, true);
    assert.equal(result.perToken.find((token) => token.symbol === "SLAY")?.balanceUsd, 27_000);
    assert.equal(result.perToken.find((token) => token.symbol === "USDC")?.balanceUsd, 98);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("keeps a complete Starkscan snapshot cacheable when an asset is unpriced", async () => {
  const snapshot: PrivacyPoolTvlResponse = {
    schemaVersion: "1",
    chainId: "SN_MAIN",
    scope: "strk20_privacy_pool",
    accountingMethod: "finalized_public_flow_ledger_v1",
    status: "complete",
    asOf: {
      blockNumber: 123,
      blockHash: "0xabc",
      blockTimestamp: "2026-08-20T10:00:00.000Z",
      materializedAt: "2026-08-20T10:00:01.000Z",
    },
    coverage: {
      status: "complete",
      reasonCode: "finalized_public_flow_ledger",
      finalizedOnly: true,
      finalityBasis: "starkscan_indexed_finalized_tier",
      latestL1AcceptedBlockNumber: 120,
      asOfL1Accepted: false,
      fromBlockNumber: 1,
      throughBlockNumber: 123,
      latestEventBlockNumber: 122,
      latestEventCursor: "122:1:0",
      poolContractCount: 1,
      tokenCount: 1,
      missingAmountEventCount: 0,
      decodedMaterializationFresh: true,
      decodedEventLagBlocks: 0,
    },
    assets: [{ ...asset(SLAY, "SLAY", 18, "1000000000000000000"),
      price: { status: "unavailable", priceUsd: null, source: null }, valueUsd: null }],
    caveat: "finalized public flow",
  };
  const client = new StarkscanClient({
    baseUrl: "https://api.starkscan.test",
    apiKey: "test-key",
    maxRetries: 0,
    fetch: (async () => Response.json(snapshot)) as typeof fetch,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(snapshot)) as typeof fetch;
  const db = openCache(":memory:");
  try {
    const result = await currentTvl(
      client,
      db,
      new ViewCache(db),
      new TokenMetaCache(db),
      new AvnuTokenIndex(),
      "SN_MAIN",
      "0xpool"
    );
    assert.equal(result.totalUsd, 0);
    assert.equal(result.partial, false);
    assert.equal(result.unpricedTokenCount, 1);
    assert.equal(result.priceCoverageComplete, false);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

function asset(
  address: string,
  symbol: string,
  decimals: number,
  protectedAmountRaw: string
): PrivacyPoolTvlResponse["assets"][number] {
  return {
    token: { address, symbol, name: symbol, decimals },
    status: "complete",
    reasonCode: "finalized_public_flow_ledger",
    poolContractCount: 1,
    depositEventCount: 1,
    withdrawalEventCount: 0,
    depositAmountRaw: protectedAmountRaw,
    withdrawalAmountRaw: "0",
    protectedAmountRaw,
    protectedAmount: null,
    missingAmountEventCount: 0,
    price: { status: "priced", priceUsd: symbol === "USDC" ? "0.98" : "0.001", source: "coingecko" },
    valueUsd: String(Number(protectedAmountRaw) / 10 ** decimals * (symbol === "USDC" ? 0.98 : 0.001)),
  };
}

function marketToken(tokenAddress: string, symbol: string, priceUsd: number) {
  return {
    tokenAddress,
    name: symbol,
    symbol,
    decimals: symbol === "USDC" ? 6 : 18,
    logoUri: null,
    priceUsd,
    source: "avnu",
    updatedAtIso: "2026-08-20T10:00:00.000Z",
  };
}


function completeSnapshot(): PrivacyPoolTvlResponse {
  return {
    schemaVersion: "1",
    chainId: "SN_MAIN",
    scope: "strk20_privacy_pool",
    accountingMethod: "finalized_public_flow_ledger_v1",
    status: "complete",
    asOf: {
      blockNumber: 123,
      blockHash: "0xabc",
      blockTimestamp: "2026-08-20T10:00:00.000Z",
      materializedAt: "2026-08-20T10:00:01.000Z",
    },
    coverage: {
      status: "complete",
      reasonCode: "finalized_public_flow_ledger",
      finalizedOnly: true,
      finalityBasis: "starkscan_indexed_finalized_tier",
      latestL1AcceptedBlockNumber: 120,
      asOfL1Accepted: false,
      fromBlockNumber: 1,
      throughBlockNumber: 123,
      latestEventBlockNumber: 122,
      latestEventCursor: "122:1:0",
      poolContractCount: 1,
      tokenCount: 2,
      missingAmountEventCount: 0,
      decodedMaterializationFresh: true,
      decodedEventLagBlocks: 0,
    },
    assets: [
      asset(SLAY, "SLAY", 18, "27000000000000000000000000"),
      asset(USDC, "USDC", 6, "100000000"),
    ],
    caveat: "finalized public flow",
  };
}

test("includes xSTRK and SLAY even if an independent quote API misses them", () => {
  const snapshot = completeSnapshot();
  const xstrk = asset("0x28d", "xSTRK", 18, "9350000000000000000000000");
  xstrk.valueUsd = "1039348.8470482074";
  snapshot.assets = [xstrk, { ...asset(SLAY, "SLAY", 18, "19760453000000000000000000"),
    valueUsd: "246017.8021990605" }];
  const result = valueStarkscanSnapshot(snapshot);
  assert.equal(result.totalUsd, 1039348.8470482074 + 246017.8021990605);
  assert.equal(result.tvlSource, "starkscan-finalized");
});

test("missing snapshot valuations fail instead of fabricating a zero", () => {
  const snapshot = completeSnapshot();
  delete snapshot.assets[0]!.price;
  assert.throws(() => valueStarkscanSnapshot(snapshot), /valuation missing/);
});

test("an incomplete Starkscan snapshot is never accepted", () => {
  const snapshot = completeSnapshot();
  snapshot.coverage.decodedMaterializationFresh = false;
  assert.throws(() => valueStarkscanSnapshot(snapshot), /incomplete Starkscan coverage/);
});

test("a Starkscan outage never triggers balanceOf or local event TVL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  const db = openCache(":memory:");
  try {
    await assert.rejects(currentTvl(
      new StarkscanClient({ baseUrl: "https://test", apiKey: "test" }), db,
      new ViewCache(db), new TokenMetaCache(db), new AvnuTokenIndex(), "SN_MAIN", "0xpool"
    ), /Starkscan explorer 503/);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});


test("unpriced assets without decimals do not invalidate Starkscan's complete USD subtotal", () => {
  const snapshot = completeSnapshot();
  const unknown = asset("0x208", "unknown", 18, "123456");
  unknown.token.decimals = null;
  unknown.price = { status: "unavailable", priceUsd: null, source: null };
  unknown.valueUsd = null;
  snapshot.assets.push(unknown);
  snapshot.coverage.tokenCount = 3;
  const result = valueStarkscanSnapshot(snapshot);
  assert.equal(result.totalUsd, 27_098);
  assert.equal(result.partial, false);
  assert.equal(result.unpricedTokenCount, 1);
  assert.equal(result.priceCoverageComplete, false);
});
