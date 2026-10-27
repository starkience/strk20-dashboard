import { test } from "node:test";
import assert from "node:assert/strict";
import type { TvlSummary } from "../aggregations/tvl.js";
import { measureEndurTvl } from "./endur-tvl.js";

const XSTRK = "0x28d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a";
const XWBTC = "0x6a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13";
const OTHER = "0x1";

function pool(now: number): TvlSummary {
  const asset = (address: string, balanceRaw: string, decimals: number) => ({
    address, balanceRaw, decimals, symbol: address, logoUri: null, coingeckoId: null,
    balanceHuman: 0, balanceUsd: 0, depositCount: 0, withdrawalCount: 0,
    priced: false, identified: true, source: "starkscan" as const,
  });
  return {
    totalUsd: 0, tvlSource: "starkscan-finalized",
    accountingMethod: "finalized_public_flow_ledger_v1", tvlAsOfBlock: 123,
    tvlAsOf: new Date(now - 30_000).toISOString(), depositCount: 0,
    withdrawalCount: 0, tokenCount: 3, perToken: [
      asset(XSTRK, "100000000000000000000", 18),
      asset(XWBTC, "1000000", 8),
      asset(OTHER, "100000000000000000000", 18),
    ], unpricedTokenCount: 3, priceCoverageComplete: false, partial: false,
    fetchedAt: now,
  };
}

test("Endur card splits current protocol TVL by finalized pool-held LST value", async () => {
  const now = Date.now();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/protocol/endur")) return Response.json({tvl: [
      {date: Math.floor(now / 1000), totalLiquidityUSD: 1_000},
    ]});
    if (url.endsWith("/tokens")) {
      assert.deepEqual(JSON.parse(String(init?.body)).addresses.sort(), [XSTRK, XWBTC].sort());
      return Response.json({items: [
        {tokenAddress: XSTRK, priceUsd: 1, updatedAtIso: new Date(now).toISOString()},
        {tokenAddress: XWBTC, priceUsd: 20_000, updatedAtIso: new Date(now).toISOString()},
      ]});
    }
    return new Response(null, {status: 404});
  };
  const result = await measureEndurTvl({poolTvl: async () => pool(now), fetchImpl: fetchImpl as typeof fetch, now: () => now});
  assert.equal(result.private, 300);
  assert.equal(result.public, 700);
  assert.equal(result.poolTokens, 2);
  assert.equal(result.asOfBlock, 123);
});

test("Endur metric fails closed when a held LST lacks a current quote", async () => {
  const now = Date.now();
  const fetchImpl = async (input: RequestInfo | URL) => String(input).endsWith("/protocol/endur")
    ? Response.json({tvl: [{date: Math.floor(now / 1000), totalLiquidityUSD: 1_000}]})
    : Response.json({items: [{tokenAddress: XSTRK, priceUsd: 1, updatedAtIso: new Date(now).toISOString()}]});
  await assert.rejects(() => measureEndurTvl({poolTvl: async () => pool(now), fetchImpl: fetchImpl as typeof fetch, now: () => now}),
    /quote unavailable/);
});
