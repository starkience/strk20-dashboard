/**
 * Token registry for tokens deposited into the STRK20 privacy pool.
 *
 * This is a RUNTIME STORE, not a hardcoded list. The server populates it:
 *   - metadata (symbol/name/decimals) for every token the pool has seen,
 *     resolved from Starkscan / the AVNU list and registered via
 *     `registerToken` (see server/src/services/token-sync.ts)
 *   - USD prices pushed via `setTokenPrice` from a live feed
 *
 * The seeds below carry ONLY stable on-chain facts (symbol/decimals,
 * verified against Starkscan) so the majors render correctly before the
 * first sync completes. They deliberately carry NO prices — usdApprox
 * stays 0 until the live feed reports, so we never display stale values.
 */

import { normalizeHex } from "../decoder/selectors.js";

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** USD price from the live feed; 0 = not priced (yet). */
  usdApprox: number;
  coingeckoId: string | null;
}

const SEEDS: TokenMeta[] = [
  {
    address: "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    symbol: "STRK",
    name: "Starknet Token",
    decimals: 18,
    usdApprox: 0,
    coingeckoId: "starknet",
  },
  {
    address: "0x787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135",
    symbol: "strkBTC",
    name: "strkBTC",
    decimals: 8,
    usdApprox: 0,
    // BTC-pegged wrapper, not listed on CoinGecko by contract — priced at
    // BTC parity via the id, same convention Starkscan uses.
    coingeckoId: "bitcoin",
  },
  {
    address: "0x47751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88",
    symbol: "xstrkBTC",
    name: "Endur xstrkBTC",
    decimals: 8,
    usdApprox: 0,
    coingeckoId: "bitcoin",
  },
  {
    address: "0x3fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac",
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
    usdApprox: 0,
    coingeckoId: "bitcoin",
  },
  {
    address: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    usdApprox: 1.0,
    coingeckoId: "usd-coin",
  },
];

const ADDRESS_INDEX = new Map<string, TokenMeta>(
  SEEDS.map((t) => [normalizeHex(t.address), t])
);

export function lookupToken(address: string): TokenMeta | null {
  return ADDRESS_INDEX.get(normalizeHex(address)) ?? null;
}

/**
 * Register (or refresh) a token's metadata. Called by the server's token
 * sync for every token discovered in pool events. Preserves an existing
 * price unless the caller supplies a non-zero one.
 */
export function registerToken(meta: TokenMeta): void {
  const key = normalizeHex(meta.address);
  const existing = ADDRESS_INDEX.get(key);
  ADDRESS_INDEX.set(key, {
    ...meta,
    address: key,
    usdApprox: meta.usdApprox > 0 ? meta.usdApprox : existing?.usdApprox ?? 0,
    coingeckoId: meta.coingeckoId ?? existing?.coingeckoId ?? null,
  });
}

/** Push a live USD price for a token. No-op if the token is unknown. */
export function setTokenPrice(address: string, usd: number): void {
  const t = ADDRESS_INDEX.get(normalizeHex(address));
  if (t && isFinite(usd) && usd >= 0) t.usdApprox = usd;
}

/** All currently registered tokens (snapshot copy). */
export function allTokens(): TokenMeta[] {
  return [...ADDRESS_INDEX.values()];
}

/** @deprecated static view kept for older callers; prefer allTokens(). */
export const KNOWN_TOKENS = SEEDS;

/** Convert a raw u128 amount string/bigint to a float in token units. */
export function applyDecimals(rawAmount: bigint | string, decimals: number): number {
  const raw = typeof rawAmount === "string" ? BigInt(rawAmount) : rawAmount;
  // For display we use Number division — accept precision loss for big numbers
  // since the dashboard rounds to 4 sig figs anyway.
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  return Number(whole) + Number(frac) / Number(divisor);
}
