/** Matched Endur TVL split: publicly reported protocol TVL less Endur LSTs
 * held by the STRK20 pool, valued from a finalized pool balance snapshot.
 * Cumulative routed staking volume is a separate activity measure.
 */
import { normalizeHex } from "@strk20/core";
import type { TvlSummary } from "../aggregations/tvl.js";
import { fetchStarkscanMarketSnapshot } from "./starkscan-market.js";

const LLAMA_URL = "https://api.llama.fi/protocol/endur";
const REFRESH_MS = 120_000;
const STALE_MS = 10 * 60_000;
const QUOTE_STALE_MS = 10 * 60_000;
const LSTS = new Set([
  "0x28d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a", // xSTRK
  "0x6a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13", // xWBTC
  "0x43a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91", // xtBTC
  "0x7dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0", // xLBTC
  "0x580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9", // xsBTC
  "0x47751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88", // xstrkBTC
].map(normalizeHex));

type Values = { public: number; private: number; poolTokens: number; asOfBlock: number };

export async function measureEndurTvl(opts: {poolTvl: () => Promise<TvlSummary>; fetchImpl?: typeof fetch; now?: () => number}): Promise<Values> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pool = await opts.poolTvl();
  const poolTime = Date.parse(pool.tvlAsOf ?? "");
  if (pool.tvlSource !== "starkscan-finalized" || pool.accountingMethod !== "finalized_public_flow_ledger_v1"
      || !Number.isSafeInteger(pool.tvlAsOfBlock) || !Number.isFinite(poolTime)
      || now() - poolTime > STALE_MS || poolTime > now() + 60_000) throw Error("Endur pool balance snapshot stale");
  const holdings = pool.perToken.filter((token) => LSTS.has(normalizeHex(token.address)) && BigInt(token.balanceRaw) > 0n);
  const [market, response] = await Promise.all([
    fetchStarkscanMarketSnapshot(holdings.map((token) => token.address), {fetch: fetchImpl}),
    fetchImpl(LLAMA_URL, {signal: AbortSignal.timeout(20_000)}),
  ]);
  if (!response.ok) throw Error(`Endur protocol TVL HTTP ${response.status}`);
  const body = await response.json() as {tvl?: {date:number;totalLiquidityUSD:number}[]};
  const latest = body.tvl?.at(-1);
  if (!latest || !Number.isFinite(latest.totalLiquidityUSD) || latest.totalLiquidityUSD < 0
      || !Number.isFinite(latest.date) || now() - latest.date * 1000 > 48 * 60 * 60_000) {
    throw Error("Endur protocol TVL unavailable or stale");
  }
  let privateUsd = 0;
  for (const token of holdings) {
    const quote = market.tokens.get(normalizeHex(token.address));
    const quotedAt = Date.parse(quote?.updatedAtIso ?? "");
    if (token.decimals == null || token.decimals < 0 || token.decimals > 36
        || !quote || !Number.isFinite(quote.priceUsd) || quote.priceUsd! <= 0
        || !Number.isFinite(quotedAt) || now() - quotedAt > QUOTE_STALE_MS || quotedAt > now() + 60_000) {
      throw Error("Endur LST quote unavailable or stale");
    }
    const value = Number(BigInt(token.balanceRaw)) / 10 ** token.decimals * quote.priceUsd!;
    if (!Number.isFinite(value) || value < 0) throw Error("Invalid Endur LST value");
    privateUsd += value;
  }
  if (privateUsd > latest.totalLiquidityUSD + 0.01) throw Error("Endur pool-held LSTs exceed protocol TVL");
  return {public: Math.max(0, latest.totalLiquidityUSD - privateUsd), private: privateUsd,
    poolTokens: holdings.length, asOfBlock: pool.tvlAsOfBlock!};
}

export function createEndurTvlService(opts: {poolTvl: () => Promise<TvlSummary>; chain: string; fetchImpl?: typeof fetch; now?: () => number}) {
  const now = opts.now ?? Date.now;
  let current: {value: Values; updatedAt: number}|null = null;
  let failed = false, busy = false;
  async function refresh() {
    if (busy || opts.chain !== "SN_MAIN") return;
    busy = true;
    try {current = {value: await measureEndurTvl(opts), updatedAt: now()}; failed = false;}
    catch (error) {failed = true; console.error("endur-tvl:", error);}
    finally {busy = false;}
  }
  function snapshot() {
    const live = current != null && now() - current.updatedAt <= STALE_MS;
    return {schemaVersion: 1, protocol: "endur", scope: "protocol-tvl-less-strk20-pool-held-lsts",
      status: live ? "live" : current ? "stale" : failed ? "unavailable" : "indexing",
      unit: "usd", basis: "Endur protocol TVL; private is STRK20 pool-held LST value",
      public: live ? current!.value.public : null, private: live ? current!.value.private : null,
      poolTokens: live ? current!.value.poolTokens : null, asOfBlock: live ? current!.value.asOfBlock : null,
      asOf: current ? new Date(current.updatedAt).toISOString() : null};
  }
  function start() {if (opts.chain === "SN_MAIN") {void refresh(); setInterval(() => void refresh(), REFRESH_MS);}}
  return {refresh, snapshot, start};
}
