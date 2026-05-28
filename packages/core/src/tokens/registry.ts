/**
 * Token registry for tokens deposited into the STRK20 privacy pool.
 *
 * Metadata (symbol + decimals) is sourced from Starkscan's /token/{addr}
 * endpoint — verified May 26 2026. USD prices are placeholders that should
 * be replaced with a live price feed (CoinGecko/Pyth) before launch.
 */

import { normalizeHex } from "../decoder/selectors.js";

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Approximate USD price. TODO: swap for live feed. */
  usdApprox: number;
  coingeckoId: string | null;
}

const _REGISTRY: TokenMeta[] = [
  {
    address: "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    symbol: "STRK",
    name: "Starknet Token",
    decimals: 18,
    usdApprox: 0.15,
    coingeckoId: "starknet",
  },
  {
    address: "0x787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135",
    symbol: "strkBTC",
    name: "strkBTC",
    decimals: 8,
    usdApprox: 95_000,
    coingeckoId: "bitcoin",
  },
  {
    address: "0x47751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88",
    symbol: "xstrkBTC",
    name: "Endur xstrkBTC",
    decimals: 8,
    usdApprox: 95_000,
    coingeckoId: "bitcoin",
  },
  {
    address: "0x3fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac",
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
    usdApprox: 95_000,
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
  _REGISTRY.map((t) => [normalizeHex(t.address), t])
);

export function lookupToken(address: string): TokenMeta | null {
  return ADDRESS_INDEX.get(normalizeHex(address)) ?? null;
}

export const KNOWN_TOKENS = _REGISTRY;

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
