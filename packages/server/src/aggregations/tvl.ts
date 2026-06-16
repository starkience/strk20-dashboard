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
import { tvlHistory } from "./tvl-history.js";

// TVL balances: PRIMARY source is Starkscan's balance-of (production endpoint).
// A Starknet RPC node (`rpcBalanceOf`) is the fallback AND a silent-zero guard —
// Starkscan's balance proxy has been seen to return 0 for every token (the cause
// of the $0-TVL incident), so a 0 from Starkscan on a token the pool actually
// holds is re-checked on-chain. Both reads are time-bounded so a hung upstream
// can't freeze the recompute; if everything fails the total falls back to the
// event-derived TVL.
const RPC_URL = process.env.STARKNET_RPC_URL || "https://rpc.starknet.lava.build";
const BALANCE_OF_SELECTOR =
  "0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e";
const READ_TIMEOUT_MS = 6_000;

/** Reject after `ms` so one hung balance read can't stall the per-token loop. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

async function rpcBalanceOf(token: string, owner: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_call",
        params: [
          { contract_address: token, entry_point_selector: BALANCE_OF_SELECTOR, calldata: [owner] },
          "latest",
        ],
      }),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = (await res.json()) as { result?: string[] };
    const r = body.result;
    if (!Array.isArray(r) || r.length === 0) throw new Error("empty balanceOf result");
    const low = BigInt(r[0] ?? "0x0");
    const high = r.length > 1 ? BigInt(r[1] ?? "0x0") : 0n; // u256 = (high << 128) | low
    return ((high << 128n) | low).toString();
  } finally {
    clearTimeout(t);
  }
}

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
  /** Where totalUsd came from: live on-chain balances, or the event-derived fallback. */
  tvlSource: "onchain" | "events-fallback";
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
    const c = counts.get(address) ?? { depositCount: 0, withdrawalCount: 0 };

    let balanceRaw = "0";
    try {
      // PRIMARY: Starkscan balance-of (production endpoint), per the data-source decision
      const res = await withTimeout(
        client.tokenBalanceOf(address, pool),
        READ_TIMEOUT_MS,
        "starkscan balanceOf",
      );
      balanceRaw = res.balanceRaw ?? "0";
    } catch {
      // FALLBACK: read balanceOf straight from a Starknet RPC node
      try { balanceRaw = await rpcBalanceOf(address, pool); } catch { partial = true; }
    }
    // GUARD against Starkscan's known silent-zero failure: if the pool has
    // actually received this token but Starkscan reports 0, confirm on-chain
    // via RPC before trusting the zero (prevents a recurrence of the $0 TVL).
    if (balanceRaw === "0" && c.depositCount > 0) {
      try {
        const onchain = await rpcBalanceOf(address, pool);
        if (onchain !== "0") balanceRaw = onchain;
      } catch {
        /* keep 0 */
      }
    }

    const balanceHuman = applyDecimals(balanceRaw, meta.decimals);
    const balanceUsd = balanceHuman * meta.usdApprox;
    totalUsd += balanceUsd;
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

  // Safety net: if every balance read failed (RPC + Starkscan), never show $0 —
  // fall back to the event-derived TVL (reconstructed from cached pool events;
  // always available, no external calls). Keeps the headline robust to outages.
  let tvlSource: TvlSummary["tvlSource"] = "onchain";
  if (!(totalUsd > 0)) {
    try {
      const h = tvlHistory(db, chain, pool);
      const last = h.days[h.days.length - 1];
      if (last && last.tvlUsd > 0) {
        totalUsd = last.tvlUsd;
        tvlSource = "events-fallback";
      }
    } catch {
      /* leave totalUsd as 0 */
    }
  }

  const summary: TvlSummary = {
    totalUsd,
    tvlSource,
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
