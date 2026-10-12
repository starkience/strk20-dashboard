import type { Db } from "../cache/db.js";
import {
  applyDecimals, normalizeHex, registerToken, setTokenPrice,
  type StarkscanClient, type AvnuTokenIndex, type PrivacyPoolTvlResponse,
} from "@strk20/core";
import type { ViewCache, TokenMetaCache } from "../cache/index.js";
import { fetchStarkscanExplorerJson } from "../services/starkscan-explorer.js";

export interface TokenTvl {
  address: string;
  symbol: string;
  decimals: number | null;
  logoUri: string | null;
  coingeckoId: string | null;
  balanceRaw: string;
  balanceHuman: number | null;
  balanceUsd: number;
  depositCount: number;
  withdrawalCount: number;
  /** true if Starkscan supplies a prepared USD valuation for this token. */
  priced: boolean;
  /** true if symbol/decimals are confirmed, false if a raw-address fallback. */
  identified: boolean;
  /** where the metadata came from. */
  source: "starkscan" | "avnu" | "cache" | "chain" | "registry" | "unknown";
  /** Address-keyed USD quote source used for this balance. */
  priceSource?: string | null;
}

export interface TvlSummary {
  totalUsd: number;
  /** Starkscan is authoritative; the other values are outage-only fallbacks. */
  tvlSource: "starkscan-finalized";
  accountingMethod?: "finalized_public_flow_ledger_v1";
  tvlAsOfBlock?: number | null;
  tvlAsOf?: string | null;
  depositCount: number;
  withdrawalCount: number;
  tokenCount: number;
  perToken: TokenTvl[];
  /** Positive-balance assets Starkscan does not currently value in USD. */
  unpricedTokenCount: number;
  /** Whether every positive balance has a Starkscan explorer quote. */
  priceCoverageComplete: boolean;
  /** True only when the accounting snapshot itself is incomplete. */
  partial: boolean;
  fetchedAt: number;
}


const TVL_CACHE_KEY = "tvl:starkscan-valued:v3";
const TVL_TTL_MS = 60_000;
const pending = new WeakMap<ViewCache, Promise<TvlSummary>>();

/** Mirror the explorer's finalized amounts AND prepared asset valuations.
 * Unpriced assets are excluded from the USD subtotal, exactly as on Starkscan.
 * An unavailable source fails the request; it never triggers alternate accounting.
 */
export async function currentTvl(
  _client: StarkscanClient, db: Db, views: ViewCache, tokenMeta: TokenMetaCache,
  _avnu: AvnuTokenIndex, chain: string, _pool: string
): Promise<TvlSummary> {
  const cached = views.get<TvlSummary>(TVL_CACHE_KEY);
  if (cached) return cached;
  const existing = pending.get(views);
  if (existing) return existing;
  const request = loadSnapshot(db, views, tokenMeta, chain);
  pending.set(views, request);
  try { return await request; } finally { pending.delete(views); }
}

async function loadSnapshot(db: Db, views: ViewCache, tokenMeta: TokenMetaCache, chain: string): Promise<TvlSummary> {
  const snapshot = await fetchStarkscanExplorerJson<PrivacyPoolTvlResponse>(
    `/v1/${chain}/privacy-pool/tvl`
  );
  assertCompleteStarkscanSnapshot(snapshot);
  const result = valueStarkscanSnapshot(snapshot);
  const upsertPrice = db.prepare(`
    INSERT INTO token_prices (address, usd, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
  `);
  for (const token of result.perToken) {
    if (token.decimals == null) continue;
    const price = token.balanceHuman != null && token.balanceHuman > 0 ? token.balanceUsd / token.balanceHuman : 0;
    registerToken({ address: token.address, symbol: token.symbol, name: token.symbol,
      decimals: token.decimals, usdApprox: price, coingeckoId: null });
    setTokenPrice(token.address, price);
    upsertPrice.run(token.address, price, result.fetchedAt);
    tokenMeta.put(token.address, { symbol: token.symbol, name: token.symbol, decimals: token.decimals });
  }
  views.put(TVL_CACHE_KEY, result, TVL_TTL_MS);
  return result;
}

export function valueStarkscanSnapshot(snapshot: PrivacyPoolTvlResponse): TvlSummary {
  assertCompleteStarkscanSnapshot(snapshot);
  const perToken = snapshot.assets.map((asset): TokenTvl => {
    // Missing valuation fields are a schema/source failure, not a measured zero.
    if (!asset.price || asset.valueUsd === undefined) {
      throw new Error(`Starkscan valuation missing for ${asset.token.address}`);
    }
    const priced = asset.price.status === "priced";
    const balanceUsd = priced ? Number(asset.valueUsd) : 0;
    if (priced && (asset.valueUsd == null || !Number.isFinite(balanceUsd) || balanceUsd < 0)) {
      throw new Error(`Invalid Starkscan valuation for ${asset.token.address}`);
    }
    return {
      address: normalizeHex(asset.token.address), symbol: asset.token.symbol ?? asset.token.address,
      decimals: asset.token.decimals, logoUri: null, coingeckoId: null,
      balanceRaw: asset.protectedAmountRaw,
      balanceHuman: asset.token.decimals == null ? null : applyDecimals(asset.protectedAmountRaw, asset.token.decimals),
      balanceUsd, depositCount: asset.depositEventCount, withdrawalCount: asset.withdrawalEventCount,
      priced, identified: asset.token.symbol != null, source: "starkscan",
      priceSource: asset.price.source,
    };
  }).sort((a, b) => b.balanceUsd - a.balanceUsd);
  const unpricedTokenCount = perToken.filter((t) => BigInt(t.balanceRaw) > 0n && !t.priced).length;
  return {
    totalUsd: perToken.reduce((sum, t) => sum + t.balanceUsd, 0),
    tvlSource: "starkscan-finalized", accountingMethod: snapshot.accountingMethod,
    tvlAsOfBlock: snapshot.asOf.blockNumber, tvlAsOf: snapshot.asOf.blockTimestamp,
    depositCount: perToken.reduce((sum, t) => sum + t.depositCount, 0),
    withdrawalCount: perToken.reduce((sum, t) => sum + t.withdrawalCount, 0),
    tokenCount: perToken.length, perToken, unpricedTokenCount,
    priceCoverageComplete: unpricedTokenCount === 0, partial: false, fetchedAt: Date.now(),
  };
}

function assertCompleteStarkscanSnapshot(
  snapshot: Awaited<ReturnType<StarkscanClient["privacyPoolTvl"]>>
): void {
  if (
    snapshot.status !== "complete" ||
    snapshot.coverage.status !== "complete" ||
    snapshot.coverage.missingAmountEventCount !== 0 ||
    snapshot.coverage.decodedMaterializationFresh !== true
  ) {
    throw new Error(
      `incomplete Starkscan coverage (${snapshot.status}/${snapshot.coverage.status})`
    );
  }
  if (snapshot.assets.length !== snapshot.coverage.tokenCount) {
    throw new Error("Starkscan token coverage count mismatch");
  }

  for (const asset of snapshot.assets) {
    const decimals = asset.token.decimals;
    if (
      asset.status !== "complete" ||
      asset.missingAmountEventCount !== 0 ||
      (decimals == null ? asset.price?.status === "priced" :
        !Number.isInteger(decimals) || decimals < 0 || decimals > 255) ||
      !/^\d+$/.test(asset.protectedAmountRaw)
    ) {
      throw new Error(`incomplete Starkscan asset ${asset.token.address}`);
    }
  }
}
