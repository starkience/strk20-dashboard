import { applyDecimals } from "@strk20/core";
import type { ViewCache } from "../cache/index.js";
import type { TvlSummary } from "../aggregations/tvl.js";
import { fetchStarkscanExplorerJson } from "./starkscan-explorer.js";

interface MetricSeries {
  shieldedSupplySeries: { bucketStartIso: string; shieldedSupplyRaw: string }[];
  privacyFeeSeries: { bucketStartIso: string; cumulativeFeeAmountRaw: string }[];
}

const pending = new WeakMap<ViewCache, Promise<StarkscanHistory>>();
export interface StarkscanHistory {
  days: { date: string; total: number; byToken: Record<string, number>; feesUsd: number }[];
  tokens: string[];
  pricedAt: "current";
  source: "starkscan-finalized";
  tvlSource: "starkscan-finalized";
  tvlAsOf: string | null | undefined;
  tvlAsOfBlock: number | null | undefined;
}

/** The same per-asset public-flow series and current snapshot prices as Starkscan. */
export async function starkscanTvlHistory(
  tvl: TvlSummary, views: ViewCache, chain: string
): Promise<StarkscanHistory> {
  const key = `starkscan-tvl-series:v1:${chain}:${tvl.tvlAsOfBlock}:${tvl.totalUsd}`;
  const cached = views.get<StarkscanHistory>(key);
  if (cached) return cached;
  const existing = pending.get(views);
  if (existing) {
    await existing;
    return starkscanTvlHistory(tvl, views, chain);
  }
  const promise = loadHistory(tvl, chain);
  pending.set(views, promise);
  try {
    const result = await promise;
    views.put(key, result, 60_000);
    return result;
  } finally {
    pending.delete(views);
  }
}

async function loadHistory(tvl: TvlSummary, chain: string): Promise<StarkscanHistory> {
  const assets = tvl.perToken.filter((t) => t.priced && t.balanceUsd > 0);
  const series: MetricSeries[] = new Array(assets.length);
  let cursor = 0;
  // Bound the burst so chart requests don't monopolize the upstream.
  await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
    while (cursor < assets.length) {
      const i = cursor++;
      series[i] = await fetchStarkscanExplorerJson<MetricSeries>(
        `/v1/${chain}/privacy-pool/metrics/series?range=all&granularity=day&token=${assets[i]!.address}`
      );
      if (!Array.isArray(series[i]!.shieldedSupplySeries) || !series[i]!.shieldedSupplySeries.length) {
        throw new Error(`Starkscan history unavailable for ${assets[i]!.symbol}`);
      }
    }
  }));
  return assembleStarkscanHistory(tvl, assets, series);
}

export function assembleStarkscanHistory(
  tvl: TvlSummary, assets: TvlSummary["perToken"], series: MetricSeries[]
): StarkscanHistory {
  const lastDate = (tvl.tvlAsOf ?? new Date().toISOString()).slice(0, 10);
  const dates = [...new Set(series.flatMap((s) => s.shieldedSupplySeries
    .map((p) => p.bucketStartIso.slice(0, 10))))].filter((d) => d <= lastDate).sort();
  if (!dates.includes(lastDate)) dates.push(lastDate);
  const amounts = series.map((s) => new Map(s.shieldedSupplySeries.map((p) =>
    [p.bucketStartIso.slice(0, 10), p.shieldedSupplyRaw])));
  const fees = new Map((series[0]?.privacyFeeSeries ?? []).map((p) =>
    [p.bucketStartIso.slice(0, 10), p.cumulativeFeeAmountRaw]));
  const strk = tvl.perToken.find((t) => t.symbol === "STRK");
  const strkPrice = strk?.balanceHuman ? strk.balanceUsd / strk.balanceHuman : 0;
  const running = assets.map(() => "0");
  let feeRaw = "0";
  const days = dates.map((date) => {
    const byToken: Record<string, number> = {};
    for (let i = 0; i < assets.length; i++) {
      const token = assets[i]!;
      running[i] = amounts[i]!.get(date) ?? running[i]!;
      const price = token.balanceUsd / token.balanceHuman!;
      const usd = date === lastDate ? token.balanceUsd
        : applyDecimals(running[i]!, token.decimals!) * price;
      if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid Starkscan series: ${token.symbol}`);
      byToken[token.symbol] = (byToken[token.symbol] ?? 0) + usd;
    }
    feeRaw = fees.get(date) ?? feeRaw;
    return { date, byToken, total: date === lastDate ? tvl.totalUsd : Object.values(byToken).reduce((a, b) => a + b, 0),
      feesUsd: applyDecimals(feeRaw, 18) * strkPrice };
  });
  return { days, tokens: assets.map((t) => t.symbol), pricedAt: "current",
    source: "starkscan-finalized", tvlSource: "starkscan-finalized",
    tvlAsOf: tvl.tvlAsOf, tvlAsOfBlock: tvl.tvlAsOfBlock };
}
