import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  type StarkscanClient,
} from "@strk20/core";
import type { ViewCache, TokenMetaCache } from "../cache/index.js";

export interface TokenTvl {
  address: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balanceHuman: number;
  balanceUsd: number;
  depositCount: number;
  withdrawalCount: number;
  /** true if we have a USD price for this token (registry-priced majors). */
  priced: boolean;
  /** true if symbol/decimals are confirmed (registry or fetched), false if a raw-address fallback. */
  identified: boolean;
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
  chain: string,
  pool: string
): Promise<TvlSummary> {
  const cached = views.get<TvlSummary>(TVL_CACHE_KEY);
  if (cached) return cached;

  const tokens = discoverTokens(db, chain, pool);
  const counts = depositWithdrawCountsByToken(db, chain, pool);

  let totalUsd = 0;
  let partial = false;
  const perToken: TokenTvl[] = [];

  for (const address of tokens) {
    const meta = await resolveToken(address, client, tokenMeta);

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
      balanceRaw,
      balanceHuman,
      balanceUsd,
      depositCount: c.depositCount,
      withdrawalCount: c.withdrawalCount,
      priced: meta.usdApprox > 0,
      identified: meta.identified,
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
  usdApprox: number;
  identified: boolean;
}

async function resolveToken(
  address: string,
  client: StarkscanClient,
  tokenMeta: TokenMetaCache
): Promise<ResolvedToken> {
  // 1) static registry — trusted decimals + USD price
  const reg = lookupToken(address);
  if (reg) {
    return { symbol: reg.symbol, decimals: reg.decimals, usdApprox: reg.usdApprox, identified: true };
  }
  // 2) persistent metadata cache
  const cached = tokenMeta.get(address);
  if (cached?.decimals != null) {
    return {
      symbol: cached.symbol ?? shortAddr(address),
      decimals: cached.decimals,
      usdApprox: 0,
      identified: cached.symbol != null,
    };
  }
  // 3) fetch once from Starkscan, then cache forever
  try {
    const m = await client.tokenMeta(address);
    tokenMeta.put(address, { symbol: m.symbol, name: m.name, decimals: m.decimals });
    return {
      symbol: m.symbol ?? shortAddr(address),
      decimals: m.decimals ?? 18,
      usdApprox: 0,
      identified: m.symbol != null,
    };
  } catch {
    return { symbol: shortAddr(address), decimals: 18, usdApprox: 0, identified: false };
  }
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
