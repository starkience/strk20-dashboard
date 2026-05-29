import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  decodeTokenSymbol,
  decodeDecimals,
  ERC20_SYMBOL_SELECTOR,
  ERC20_DECIMALS_SELECTOR,
  type StarkscanClient,
  type AvnuTokenIndex,
} from "@strk20/core";
import type { ViewCache, TokenMetaCache } from "../cache/index.js";

export interface TokenTvl {
  address: string;
  symbol: string;
  decimals: number;
  logoUri: string | null;
  coingeckoId: string | null;
  balanceRaw: string;
  balanceHuman: number;
  balanceUsd: number;
  depositCount: number;
  withdrawalCount: number;
  /** true if we have a USD price for this token (registry-priced majors). */
  priced: boolean;
  /** true if symbol/decimals are confirmed, false if a raw-address fallback. */
  identified: boolean;
  /** where the metadata came from. */
  source: "avnu" | "cache" | "chain" | "registry" | "unknown";
}

export interface TvlSummary {
  totalUsd: number;
  depositCount: number;
  withdrawalCount: number;
  tokenCount: number;
  perToken: TokenTvl[];
  partial: boolean;
  fetchedAt: number;
}

const TVL_CACHE_KEY = "tvl:current";
const TVL_TTL_MS = 60_000;

/**
 * Live TVL across EVERY token the pool has ever seen — discovered from events,
 * not from a fixed list. Each token's symbol/decimals come from (1) the static
 * registry, (2) the persistent token_meta cache, or (3) a one-time Starkscan
 * fetch. USD price is best-effort: only registry-priced majors contribute to
 * the USD total; everything else is listed with its native balance.
 */
export async function currentTvl(
  client: StarkscanClient,
  db: Db,
  views: ViewCache,
  tokenMeta: TokenMetaCache,
  avnu: AvnuTokenIndex,
  chain: string,
  pool: string
): Promise<TvlSummary> {
  const cached = views.get<TvlSummary>(TVL_CACHE_KEY);
  if (cached) return cached;

  await avnu.ensureLoaded();
  const tokens = discoverTokens(db, chain, pool);
  const counts = depositWithdrawCountsByToken(db, chain, pool);

  let totalUsd = 0;
  let partial = false;
  const perToken: TokenTvl[] = [];

  for (const address of tokens) {
    const meta = await resolveToken(address, avnu, client, tokenMeta);

    let balanceRaw = "0";
    try {
      const res = await client.tokenBalanceOf(address, pool);
      balanceRaw = res.balanceRaw ?? "0";
    } catch {
      partial = true;
    }

    const balanceHuman = applyDecimals(balanceRaw, meta.decimals);
    const balanceUsd = balanceHuman * meta.usdApprox;
    totalUsd += balanceUsd;

    const c = counts.get(address) ?? { depositCount: 0, withdrawalCount: 0 };
    perToken.push({
      address,
      symbol: meta.symbol,
      decimals: meta.decimals,
      logoUri: meta.logoUri,
      coingeckoId: meta.coingeckoId,
      balanceRaw,
      balanceHuman,
      balanceUsd,
      depositCount: c.depositCount,
      withdrawalCount: c.withdrawalCount,
      priced: meta.usdApprox > 0,
      identified: meta.identified,
      source: meta.source,
    });
  }

  // Sort: priced first (by USD), then by activity.
  perToken.sort((a, b) => {
    if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd;
    return b.depositCount + b.withdrawalCount - (a.depositCount + a.withdrawalCount);
  });

  const depositCount = perToken.reduce((s, t) => s + t.depositCount, 0);
  const withdrawalCount = perToken.reduce((s, t) => s + t.withdrawalCount, 0);

  const summary: TvlSummary = {
    totalUsd,
    depositCount,
    withdrawalCount,
    tokenCount: perToken.length,
    perToken,
    partial,
    fetchedAt: Date.now(),
  };
  views.put(TVL_CACHE_KEY, summary, TVL_TTL_MS);
  return summary;
}

interface ResolvedToken {
  symbol: string;
  decimals: number;
  logoUri: string | null;
  coingeckoId: string | null;
  usdApprox: number;
  identified: boolean;
  source: TokenTvl["source"];
}

/**
 * Resolve token metadata, best source first:
 *   1. AVNU list  — curated symbol/decimals/logo/coingeckoId (the requested source)
 *   2. token_meta cache — anything previously resolved on-chain
 *   3. on-chain symbol()/decimals() read — for tokens AVNU doesn't list (e.g. Vesu vTokens)
 *   4. raw short address — last resort
 * USD price comes from the static registry (priced majors) until a coingeckoId
 * price feed is wired up.
 */
async function resolveToken(
  address: string,
  avnu: AvnuTokenIndex,
  client: StarkscanClient,
  tokenMeta: TokenMetaCache
): Promise<ResolvedToken> {
  const price = lookupToken(address)?.usdApprox ?? 0;

  // 1) AVNU curated list
  const a = avnu.get(address);
  if (a) {
    return {
      symbol: a.symbol,
      decimals: a.decimals,
      logoUri: a.logoUri,
      coingeckoId: a.coingeckoId,
      usdApprox: price,
      identified: true,
      source: "avnu",
    };
  }

  // 2) persistent on-chain metadata cache
  const cached = tokenMeta.get(address);
  if (cached?.decimals != null && cached.symbol) {
    return {
      symbol: cached.symbol,
      decimals: cached.decimals,
      logoUri: null,
      coingeckoId: null,
      usdApprox: price,
      identified: true,
      source: "cache",
    };
  }

  // 3) read symbol()/decimals() directly from the token contract
  try {
    const [symRes, decRes] = await Promise.all([
      client.contractRead(address, ERC20_SYMBOL_SELECTOR),
      client.contractRead(address, ERC20_DECIMALS_SELECTOR),
    ]);
    const symbol = decodeTokenSymbol(symRes.result);
    const decimals = decodeDecimals(decRes.result);
    if (symbol) {
      tokenMeta.put(address, { symbol, name: symbol, decimals });
      return {
        symbol,
        decimals,
        logoUri: null,
        coingeckoId: null,
        usdApprox: price,
        identified: true,
        source: "chain",
      };
    }
  } catch {
    // fall through
  }

  // 4) raw address
  return {
    symbol: shortAddr(address),
    decimals: 18,
    logoUri: null,
    coingeckoId: null,
    usdApprox: price,
    identified: false,
    source: "unknown",
  };
}

/** All distinct token addresses the pool has seen in deposits/withdrawals. */
function discoverTokens(db: Db, chain: string, pool: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT topic2 AS token FROM raw_events
       WHERE chain=? AND contract=? AND topic2 IS NOT NULL
         AND topic0 IN (?, ?)`
    )
    .all(chain, pool, EVENT_SELECTORS.Deposit, EVENT_SELECTORS.Withdrawal) as {
    token: string;
  }[];
  return rows.map((r) => normalizeHex(r.token));
}

function depositWithdrawCountsByToken(
  db: Db,
  chain: string,
  pool: string
): Map<string, { depositCount: number; withdrawalCount: number }> {
  const rows = db
    .prepare(
      `SELECT topic2 as token,
        SUM(CASE WHEN topic0 = ? THEN 1 ELSE 0 END) as deps,
        SUM(CASE WHEN topic0 = ? THEN 1 ELSE 0 END) as wds
       FROM raw_events
       WHERE chain=? AND contract=? AND topic2 IS NOT NULL
         AND (topic0 = ? OR topic0 = ?)
       GROUP BY topic2`
    )
    .all(
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.Withdrawal,
      chain,
      pool,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.Withdrawal
    ) as { token: string; deps: number; wds: number }[];

  const m = new Map<string, { depositCount: number; withdrawalCount: number }>();
  for (const r of rows) {
    m.set(normalizeHex(r.token), {
      depositCount: Number(r.deps),
      withdrawalCount: Number(r.wds),
    });
  }
  return m;
}

function shortAddr(address: string): string {
  const s = address.toLowerCase();
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
