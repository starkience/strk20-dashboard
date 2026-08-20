import { test } from "node:test";
import assert from "node:assert/strict";
import { AvnuTokenIndex, StarkscanClient, type PrivacyPoolTvlResponse } from "@strk20/core";
import { openCache } from "../cache/db.js";
import { TokenMetaCache } from "../cache/tokens.js";
import { ViewCache } from "../cache/view.js";
import { currentTvl } from "./tvl.js";

const SLAY = "0x2ab";
const USDC = "0x330";

test("values Starkscan finalized amounts with Starkscan explorer quotes", async () => {
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
    const url = String(input);
    if (url.endsWith("/tokens")) {
      return Response.json({
        items: [
          marketToken(SLAY, "SLAY", 0.001),
          marketToken(USDC, "USDC", 0.98),
        ],
      });
    }
    return Response.json({ priceUsd: 1 });
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
    assert.equal(result.perToken.find((token) => token.symbol === "SLAY")?.balanceUsd, 27_000);
    assert.equal(result.perToken.find((token) => token.symbol === "USDC")?.balanceUsd, 98);
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
