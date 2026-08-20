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
  registerToken,
  setTokenPrice,
  type StarkscanClient,
  type AvnuTokenIndex,
} from "@strk20/core";
import type { ViewCache, TokenMetaCache } from "../cache/index.js";
import { tvlHistory } from "./tvl-history.js";
import {
  fetchStarkscanMarketSnapshot,
  resolveStarkscanPrice,
} from "../services/starkscan-market.js";

// Outage fallback only: Starkscan balance-of, then a Starknet RPC node.
// The RPC read is also a silent-zero guard because
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
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  source: "starkscan" | "avnu" | "cache" | "chain" | "registry" | "unknown";
  /** Address-keyed USD quote source used for this balance. */
  priceSource?: string | null;
}

export interface TvlSummary {
  totalUsd: number;
  /** Starkscan is authoritative; the other values are outage-only fallbacks. */
  tvlSource: "starkscan-finalized" | "onchain" | "events-fallback";
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

// Versioned so a deploy cannot briefly reuse an older summary whose `partial`
// field conflated accounting completeness with missing price coverage.
const TVL_CACHE_KEY = "tvl:current:v2";
const TVL_TTL_MS = 60_000;

/**
 * Current TVL mirrors Starkscan: its finalized Privacy Pool public-flow ledger
 * supplies amounts/counts and its explorer market feed supplies USD quotes.
 * Local balance/event reconstruction is retained only as an outage fallback.
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

  try {
    const starkscanSummary = await currentStarkscanTvl(
      client,
      db,
      tokenMeta,
      chain,
      pool
    );
    views.put(TVL_CACHE_KEY, starkscanSummary, TVL_TTL_MS);
    return starkscanSummary;
  } catch (error) {
    console.warn(
      `TVL: Starkscan authoritative snapshot unavailable; using fallback: ${
        (error as Error)?.message ?? String(error)
      }`
    );
  }

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
    unpricedTokenCount: perToken.filter((token) => token.balanceHuman > 0 && !token.priced).length,
    priceCoverageComplete: perToken.every((token) => token.balanceHuman <= 0 || token.priced),
    partial,
    fetchedAt: Date.now(),
  };
  views.put(TVL_CACHE_KEY, summary, TVL_TTL_MS);
  return summary;
}

/** Build the headline directly from Starkscan's supported Privacy Pool data. */
async function currentStarkscanTvl(
  client: StarkscanClient,
  db: Db,
  tokenMeta: TokenMetaCache,
  chain: string,
  pool: string
): Promise<TvlSummary> {
  const snapshot = await withTimeout(
    client.privacyPoolTvl(),
    READ_TIMEOUT_MS,
    "starkscan privacy-pool TVL"
  );
  assertCompleteStarkscanSnapshot(snapshot);

  const addresses = snapshot.assets.map((asset) => normalizeHex(asset.token.address));
  const market = await fetchStarkscanMarketSnapshot(addresses);
  const upsertPrice = db.prepare(`
    INSERT INTO token_prices (address, usd, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
  `);
  const fetchedAt = Date.now();
  const perToken: TokenTvl[] = [];
  let totalUsd = 0;
  let unpricedTokenCount = 0;

  for (const asset of snapshot.assets) {
    const address = normalizeHex(asset.token.address);
    const decimals = asset.token.decimals as number;
    const symbol = asset.token.symbol ?? shortAddr(address);
    const existing = lookupToken(address);
    const marketToken = market.tokens.get(address);
    const resolvedPrice = resolveStarkscanPrice(market, address, asset.token.symbol);
    const priceUsd = resolvedPrice?.priceUsd ?? 0;

    registerToken({
      address,
      symbol,
      name: asset.token.name ?? symbol,
      decimals,
      usdApprox: priceUsd,
      coingeckoId: existing?.coingeckoId ?? null,
    });
    // Explicitly clear a stale non-Starkscan price when the explorer considers
    // an asset unpriced; otherwise our total would drift from Starkscan.
    setTokenPrice(address, priceUsd);
    if (asset.token.symbol) {
      tokenMeta.put(address, {
        symbol: asset.token.symbol,
        name: asset.token.name,
        decimals,
      });
    }
    if (resolvedPrice) upsertPrice.run(address, priceUsd, fetchedAt);

    const balanceRaw = asset.protectedAmountRaw;
    const balanceHuman = applyDecimals(balanceRaw, decimals);
    const balanceUsd = balanceHuman * priceUsd;
    if (balanceHuman > 0 && !resolvedPrice) unpricedTokenCount += 1;
    totalUsd += balanceUsd;

    perToken.push({
      address,
      symbol,
      decimals,
      logoUri: marketToken?.logoUri ?? null,
      coingeckoId: existing?.coingeckoId ?? null,
      balanceRaw,
      balanceHuman,
      balanceUsd,
      depositCount: asset.depositEventCount,
      withdrawalCount: asset.withdrawalEventCount,
      priced: resolvedPrice != null,
      identified: asset.token.symbol != null,
      source: "starkscan",
      priceSource: resolvedPrice?.source ?? null,
    });
  }

  perToken.sort((a, b) => {
    if (b.balanceUsd !== a.balanceUsd) return b.balanceUsd - a.balanceUsd;
    return b.depositCount + b.withdrawalCount - (a.depositCount + a.withdrawalCount);
  });

  // Keep the dashboard's all-event headline counts. The finalized TVL route
  // intentionally omits zero-flow assets, so summing its per-asset counts
  // would undercount lifetime activity even though the TVL itself is exact.
  const allTokenCounts = [...depositWithdrawCountsByToken(db, chain, pool).values()];

  return {
    totalUsd,
    tvlSource: "starkscan-finalized",
    accountingMethod: snapshot.accountingMethod,
    tvlAsOfBlock: snapshot.asOf.blockNumber,
    tvlAsOf: snapshot.asOf.blockTimestamp,
    depositCount: allTokenCounts.reduce((sum, count) => sum + count.depositCount, 0),
    withdrawalCount: allTokenCounts.reduce((sum, count) => sum + count.withdrawalCount, 0),
    tokenCount: perToken.length,
    perToken,
    unpricedTokenCount,
    priceCoverageComplete: unpricedTokenCount === 0,
    // Snapshot completeness and price coverage are separate concepts.
    // Starkscan's complete accounting snapshot remains authoritative when
    // its explorer intentionally leaves a positive-balance asset unpriced.
    partial: false,
    fetchedAt,
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
      decimals == null ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255 ||
      !/^\d+$/.test(asset.protectedAmountRaw)
    ) {
      throw new Error(`incomplete Starkscan asset ${asset.token.address}`);
    }
  }
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
 * This resolver is used only by the outage fallback. Its registry price is the
 * most recent Starkscan market quote persisted by token-sync.
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
