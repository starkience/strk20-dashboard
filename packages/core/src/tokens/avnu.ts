import { normalizeHex } from "../decoder/selectors.js";

/**
 * AVNU's curated Starknet token list — symbol, decimals, logo, and a
 * coingeckoId (which also unlocks live USD pricing later).
 * https://docs.avnu.fi/docs/tokens/fetch-tokens
 */

const AVNU_TOKENS_URL = "https://starknet.api.avnu.fi/v1/starknet/tokens";
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

export interface AvnuToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string | null;
  coingeckoId: string | null;
  tags: string[];
}

interface AvnuApiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string | null;
  extensions?: { coingeckoId?: string | null };
  tags?: string[];
}

interface AvnuPage {
  content: AvnuApiToken[];
  number: number;
  totalPages: number;
}

export async function fetchAvnuTokens(fetchImpl: typeof fetch = fetch): Promise<AvnuToken[]> {
  const out: AvnuToken[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${AVNU_TOKENS_URL}?size=${PAGE_SIZE}&page=${page}`);
    if (!res.ok) break;
    const json = (await res.json()) as AvnuPage;
    for (const t of json.content) {
      out.push({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoUri: t.logoUri ?? null,
        coingeckoId: t.extensions?.coingeckoId ?? null,
        tags: t.tags ?? [],
      });
    }
    if (json.content.length === 0 || json.number >= json.totalPages - 1) break;
  }
  return out;
}

/**
 * In-memory, lazily-loaded index of the AVNU list with a TTL. The list changes
 * infrequently, so a multi-hour refresh is plenty.
 */
export class AvnuTokenIndex {
  private map = new Map<string, AvnuToken>();
  private fetchedAt = 0;

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async ensureLoaded(): Promise<void> {
    if (this.map.size > 0 && Date.now() - this.fetchedAt < this.ttlMs) return;
    try {
      const tokens = await fetchAvnuTokens(this.fetchImpl);
      if (tokens.length > 0) {
        this.map = new Map(tokens.map((t) => [normalizeHex(t.address), t]));
        this.fetchedAt = Date.now();
      }
    } catch {
      // keep whatever we have (possibly empty) — resolver falls back to chain reads
    }
  }

  get(address: string): AvnuToken | null {
    return this.map.get(normalizeHex(address)) ?? null;
  }

  get size(): number {
    return this.map.size;
  }
}
