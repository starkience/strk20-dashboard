import { normalizeHex } from "@strk20/core";

const DEFAULT_MARKET_BASE_URL = "https://starkscan.co/api/market";
const DEFAULT_TIMEOUT_MS = 6_000;

export interface StarkscanMarketToken {
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logoUri: string | null;
  priceUsd: number | null;
  source: string;
  updatedAtIso: string;
}

interface MarketTokenResponse {
  items: StarkscanMarketToken[];
}

interface ReferencePriceResponse {
  priceUsd: number | null;
  source?: string;
  updatedAtIso?: string;
}

export interface StarkscanMarketSnapshot {
  tokens: Map<string, StarkscanMarketToken>;
  strkPriceUsd: number | null;
  btcPriceUsd: number | null;
}

export interface StarkscanResolvedPrice {
  priceUsd: number;
  source: string;
}

interface MarketOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Fetches the same address-keyed quote set used by the Starkscan explorer.
 * The bulk token request is required; the STRK/BTC reference requests are
 * best-effort fallbacks matching the explorer's handling of missing quotes.
 */
export async function fetchStarkscanMarketSnapshot(
  addresses: string[],
  opts: MarketOptions = {}
): Promise<StarkscanMarketSnapshot> {
  const baseUrl = (
    opts.baseUrl ??
    process.env.STARKSCAN_MARKET_BASE_URL ??
    DEFAULT_MARKET_BASE_URL
  ).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const normalized = [...new Set(addresses.map(normalizeHex))];

  const [bulk, strk, btc] = await Promise.all([
    requestJson<MarketTokenResponse>(
      `${baseUrl}/tokens`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ addresses: normalized }),
      },
      fetchImpl,
      timeoutMs
    ),
    optionalReferencePrice(`${baseUrl}/strk`, fetchImpl, timeoutMs),
    optionalReferencePrice(`${baseUrl}/btc`, fetchImpl, timeoutMs),
  ]);

  const tokens = new Map<string, StarkscanMarketToken>();
  for (const item of bulk.items ?? []) {
    try {
      tokens.set(normalizeHex(item.tokenAddress), item);
    } catch {
      // Ignore malformed upstream addresses instead of poisoning the snapshot.
    }
  }

  return {
    tokens,
    strkPriceUsd: validPrice(strk?.priceUsd),
    btcPriceUsd: validPrice(btc?.priceUsd),
  };
}

/** Resolve a token price using the same quote-first fallbacks as Starkscan. */
export function resolveStarkscanPrice(
  snapshot: StarkscanMarketSnapshot,
  address: string,
  symbol: string | null
): StarkscanResolvedPrice | null {
  const quote = snapshot.tokens.get(normalizeHex(address));
  const direct = validPrice(quote?.priceUsd);
  if (direct != null) {
    return { priceUsd: direct, source: quote?.source ?? "starkscan-market" };
  }

  const upper = symbol?.trim().toUpperCase() ?? "";
  if (["DAI", "USDC", "USDC.E", "USDT"].includes(upper)) {
    return { priceUsd: 1, source: "starkscan-stable-fallback" };
  }
  if (upper === "STRK" && snapshot.strkPriceUsd != null) {
    return { priceUsd: snapshot.strkPriceUsd, source: "starkscan-strk-fallback" };
  }
  if (upper.includes("BTC") && snapshot.btcPriceUsd != null) {
    return { priceUsd: snapshot.btcPriceUsd, source: "starkscan-btc-fallback" };
  }
  return null;
}

async function optionalReferencePrice(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<ReferencePriceResponse | null> {
  try {
    return await requestJson<ReferencePriceResponse>(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      fetchImpl,
      timeoutMs
    );
  } catch {
    return null;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Starkscan market ${res.status}: ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function validPrice(value: unknown): number | null {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
}
