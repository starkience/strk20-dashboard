import type Database from "better-sqlite3";
import {
  EVENT_SELECTORS,
  KNOWN_TOKENS,
  applyDecimals,
  type StarkscanClient,
} from "@strk20/core";
import type { ViewCache } from "../cache/index.js";

export interface TokenTvl {
  address: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balanceHuman: number;
  balanceUsd: number;
  depositCount: number;
  withdrawalCount: number;
}

export interface TvlSummary {
  /** Live USD TVL, sum of on-chain token balances * price. */
  totalUsd: number;
  /** Sum of deposit events across all tokens (lifetime in cache). */
  depositCount: number;
  /** Sum of withdrawal events across all tokens (lifetime in cache). */
  withdrawalCount: number;
  perToken: TokenTvl[];
  /** True if any tracked token balance fetch failed — totals are a lower bound. */
  partial: boolean;
  fetchedAt: number;
}

const TVL_CACHE_KEY = "tvl:current";
const TVL_TTL_MS = 60_000;

/**
 * Live TVL: query Starkscan for the pool contract's balance of each known
 * token, sum across registry, cache for 60s.
 *
 * Per-token deposit/withdrawal counts still come from the event cache —
 * those are immune to the cache-completeness problem since they're counts,
 * and partial data underestimates rather than producing nonsense like
 * negative balances.
 */
export async function currentTvl(
  client: StarkscanClient,
  db: Database.Database,
  views: ViewCache,
  chain: string,
  pool: string
): Promise<TvlSummary> {
  const cached = views.get<TvlSummary>(TVL_CACHE_KEY);
  if (cached) return cached;

  const counts = depositWithdrawCountsByToken(db, chain, pool);

  let totalUsd = 0;
  let partial = false;
  const perToken: TokenTvl[] = [];

  for (const meta of KNOWN_TOKENS) {
    let balanceRaw = "0";
    try {
      const res = await client.tokenBalanceOf(meta.address, pool);
      balanceRaw = res.balanceRaw ?? "0";
    } catch {
      partial = true;
    }
    const balanceHuman = applyDecimals(balanceRaw, meta.decimals);
    const balanceUsd = balanceHuman * meta.usdApprox;
    totalUsd += balanceUsd;
    const c = counts.get(normalize(meta.address)) ?? {
      depositCount: 0,
      withdrawalCount: 0,
    };
    perToken.push({
      address: meta.address,
      symbol: meta.symbol,
      decimals: meta.decimals,
      balanceRaw,
      balanceHuman,
      balanceUsd,
      depositCount: c.depositCount,
      withdrawalCount: c.withdrawalCount,
    });
  }

  perToken.sort((a, b) => b.balanceUsd - a.balanceUsd);

  const depositCount = perToken.reduce((s, t) => s + t.depositCount, 0);
  const withdrawalCount = perToken.reduce((s, t) => s + t.withdrawalCount, 0);

  const summary: TvlSummary = {
    totalUsd,
    depositCount,
    withdrawalCount,
    perToken,
    partial,
    fetchedAt: Date.now(),
  };
  views.put(TVL_CACHE_KEY, summary, TVL_TTL_MS);
  return summary;
}

function depositWithdrawCountsByToken(
  db: Database.Database,
  chain: string,
  pool: string
): Map<string, { depositCount: number; withdrawalCount: number }> {
  const rows = db
    .prepare(
      `SELECT topic2 as token, topic0,
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
    m.set(normalize(r.token), {
      depositCount: r.deps,
      withdrawalCount: r.wds,
    });
  }
  return m;
}

function normalize(addr: string): string {
  const s = addr.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return "0x" + (s.length === 0 ? "0" : s);
}
