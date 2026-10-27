import { test } from "node:test";
import assert from "node:assert/strict";
import { selectorOf, type RawContractEvent } from "@strk20/core";
import { arcxTradeVolume, createAppFlowService, loadShadowAccounts, opusPositionActions, supervegaPremiums } from "./app-flows.js";
import { SHADOW_ANONYMIZER, SHADOW_DEPLOYED } from "./troves-shadow.js";

const ABBOT = "0x04d0bb0a4c40012384e7c419e6eb3c637b28e8363fb66958b60d90505b9c072f";
const SHRINE = "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada";
const SHADOW = "0xabc";
const PUBLIC = "0xdef";
const DEPLOYED_AT = Date.parse("2026-10-20T00:00:00Z");
function event(address: string, topic0: string, actor: string, block: number, index = 0): RawContractEvent {
  return { address, topic0, topic1: actor, topic2: null, topic3: null,
    blockNumber: block, txIndex: 0, logIndex: index, txHash: `0x${block.toString(16)}`,
    timestampIso: "2026-10-21T00:00:00Z", data: [] };
}
function client() {
  return {
    status: async () => ({ finalizedBlockNumber: 100, latestIndexedBlockNumber: 100 }),
    contractEvents: async (address: string, opts: {topic0?: string; cursor?: string | null}) => {
      if (address === SHADOW_ANONYMIZER) {
        assert.equal(opts.topic0, SHADOW_DEPLOYED);
        return { items: [{...event(address, SHADOW_DEPLOYED, "0x111", 10), topic2: SHADOW,
          timestampIso: new Date(DEPLOYED_AT).toISOString()}], nextCursor: null };
      }
      if (address === ABBOT && opts.topic0 === selectorOf("Deposit")) {
        if (!opts.cursor) return { items: [event(address, opts.topic0, SHADOW, 20), event(address, opts.topic0, PUBLIC, 21)], nextCursor: "next" };
        return { items: [event(address, opts.topic0, SHADOW, 9, 1)], nextCursor: null };
      }
      if (address === ABBOT && opts.topic0 === selectorOf("Withdraw")) {
        return { items: [event(address, opts.topic0, SHADOW, 22)], nextCursor: null };
      }
      if (address === ABBOT && opts.topic0 === selectorOf("TroveOpened")) {
        return { items: [
          {...event(address, opts.topic0, SHADOW, 15), topic2:"0x1"},
          {...event(address, opts.topic0, PUBLIC, 16), topic2:"0x2"},
        ], nextCursor:null };
      }
      if (address === SHRINE && opts.topic0 === selectorOf("Forge")) {
        return { items: [event(address, opts.topic0, "0x1", 30), event(address, opts.topic0, "0x2", 31)], nextCursor:null };
      }
      if (address === SHRINE && opts.topic0 === selectorOf("Melt")) {
        return { items: [event(address, opts.topic0, "0x1", 32), event(address, opts.topic0, "0x1", 9)], nextCursor:null };
      }
      throw Error("unexpected contract");
    },
  };
}
function mockFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/ct-markets")) return Promise.resolve(Response.json([
    {id:"7", quoteTokenSymbol:"USDC", quoteTokenDecimals:6},
  ]));
  if (url.includes("/ct-markets/7/fills")) {
    const first = !url.includes("cursor=");
    return Promise.resolve(Response.json(first ? {
      fills: [{fillId:"1", quoteRaw:"15000000", maker:SHADOW, taker:PUBLIC, createdAt:"2026-10-21T00:00:00Z"}], cursor:"page2",
    } : {
      fills: [
        {fillId:"1", quoteRaw:"15000000", maker:SHADOW, taker:PUBLIC, createdAt:"2026-10-21T00:00:00Z"},
        {fillId:"2", quoteRaw:"25000000", maker:PUBLIC, taker:PUBLIC, createdAt:"2026-10-21T00:00:00Z"},
      ], cursor:null,
    }));
  }
  if (url.includes("/api/activity?chain=mainnet")) return Promise.resolve(Response.json([
    {kind:"buy", txHash:"0x1", entryId:"1", actor:SHADOW, ts:DEPLOYED_AT/1000+3600, premiumUsd:12.5},
    {kind:"buy", txHash:"0x1", entryId:"1", actor:SHADOW, ts:DEPLOYED_AT/1000+3600, premiumUsd:12.5},
    {kind:"buy", txHash:"0x2", entryId:"1", actor:PUBLIC, ts:DEPLOYED_AT/1000+3600, premiumUsd:20},
    {kind:"exercise", txHash:"0x3", actor:SHADOW, ts:DEPLOYED_AT/1000+3600},
  ]));
  throw Error(`unexpected URL ${url}`);
}

test("classifies finalized Opus collateral and debt actions by verified Trove owner", async () => {
  const source = client();
  const shadows = await loadShadowAccounts(source as never, 100);
  const result = await opusPositionActions(source as never, 100, shadows);
  assert.deepEqual({unit:result.unit, public:result.public, private:result.private},
    {unit:"actions", public:3, private:4});
});

test("ArcX paginates and deduplicates fills; Supervega counts purchase premiums only", async () => {
  const shadows = new Map([[SHADOW, {block:10, deployedAt:DEPLOYED_AT}]]);
  const arcx = await arcxTradeVolume(mockFetch as typeof fetch, shadows);
  assert.equal(arcx.private, 15);
  assert.equal(arcx.public, 25);
  const supervega = await supervegaPremiums(mockFetch as typeof fetch, shadows);
  assert.equal(supervega.private, 12.5);
  assert.equal(supervega.public, 20);
});

test("failed source never becomes a measured zero and expired figures are hidden", async () => {
  let time = DEPLOYED_AT;
  const service = createAppFlowService({client: client() as never, chain:"SN_MAIN", fetchImpl: mockFetch as typeof fetch, now:()=>time});
  assert.equal(service.snapshot().apps.opus.status,"indexing");
  await service.refresh();
  assert.equal(service.snapshot().apps.opus.status,"live");
  assert.equal(service.snapshot().apps.arcx.private,15);
  time += 11*60_000;
  assert.equal(service.snapshot().apps.arcx.status,"stale");
  assert.equal(service.snapshot().apps.arcx.private,null);
  const broken = createAppFlowService({client: client() as never, chain:"SN_MAIN",
    fetchImpl: async()=>{throw Error("upstream offline")}, now:()=>time});
  await broken.refresh();
  assert.equal(broken.snapshot().apps.arcx.status,"unavailable");
  assert.equal(broken.snapshot().apps.arcx.public,null);
});
