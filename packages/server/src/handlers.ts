/**
 * Pure, framework-agnostic request handlers for the dashboard API.
 *
 * Each handler takes its arguments as a plain object and returns plain data
 * (or throws). No req/res, no Hono context, no Next.js Response — wrap them
 * in whatever server framework you want.
 *
 * Mounting in Hono:
 *   app.get("/agg/pool-summary", async (c) => c.json(await handlers.poolSummary()));
 *
 * Mounting in Next.js App Router:
 *   export const GET = async () => Response.json(await handlers.poolSummary());
 */

import {
  decodeEvent,
  EVENT_SELECTORS,
  AvnuTokenIndex,
  type RawContractEvent,
  type StarkscanClient,
} from "@strk20/core";
import { TokenMetaCache, type EventCache, type ViewCache } from "./cache/index.js";
import type { HeartbeatCache } from "./cache/heartbeats.js";
import type { Db } from "./cache/db.js";
import { syncContractEvents } from "./sync.js";
import { anonymitySet } from "./aggregations/anonymity-set.js";
import { privateOpsSince } from "./aggregations/private-ops.js";
import {
  activeDepositorsSince,
  distinctDepositorsAllTime,
} from "./aggregations/depositors.js";
import { registrationsPerDay } from "./aggregations/registrations.js";
import { activeUsersPerDay } from "./aggregations/active-users.js";
import { walletFamilies } from "./aggregations/wallet-families.js";
import { noteAgeBuckets } from "./aggregations/note-ages.js";
import { currentTvl } from "./aggregations/tvl.js";
import { activeProtocols, topCallers } from "./aggregations/protocols.js";
import { windowStats, windowConversions } from "./aggregations/window.js";
import { lifetimeConversions } from "./aggregations/lifetime-conversions.js";
import { tvlHistory } from "./aggregations/tvl-history.js";
import { volumeHistory } from "./aggregations/volume-history.js";
import { shieldedBalance } from "./aggregations/shielded-balance.js";
import { routedVolume } from "./aggregations/routed-volume.js";
import { swapVolumeByToken } from "./aggregations/swap-by-token.js";
import { actionsByProtocol } from "./aggregations/actions-by-protocol.js";
import { transactionsPerDay } from "./aggregations/transactions-per-day.js";
import { lifetimeVolume } from "./aggregations/lifetime-volume.js";
import { lifetimeRevenue } from "./aggregations/lifetime-revenue.js";
import {
  flowsGraph,
  FLOWS_GRAPH_WINDOWS_MS,
  type FlowsGraphWindow,
} from "./aggregations/flows-graph.js";
import { relayerConcentration } from "./aggregations/relayer-concentration.js";
import { recentTransactions } from "./aggregations/recent-transactions.js";
import { uptimeHistory } from "./aggregations/uptime.js";
import { contractUptime } from "./aggregations/contract-uptime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// If the sync loop hasn't completed a poll in this long, the data is stale.
// The poll runs every ~2m, so 10m = ~5 missed polls — comfortably past jitter,
// tight enough to catch a wedged indexer fast (the 20h-freeze failure mode).
const STALE_AFTER_MS = 10 * 60_000;
// A live head this far ahead of our cached head also signals trouble even if
// the loop is "succeeding" (e.g. Starkscan itself stopped indexing).
const STALE_LAG_BLOCKS = 600;

export interface Freshness {
  /** Wall-clock ms of the last successful sync poll. */
  lastSyncAt: number | null;
  /** Seconds since the last successful sync poll. */
  lastSyncAgeSeconds: number | null;
  /** ISO timestamp of the newest event we hold ("data as of"). */
  lastEventAt: string | null;
  /** Highest block number present in the cache. */
  cachedHeadBlock: number | null;
  /** Whether the full-history backfill has finished. */
  backfillComplete: boolean;
  /** True when the data should be treated as stale (drives a UI banner). */
  stale: boolean;
}

export interface HandlerDeps {
  db: Db;
  events: EventCache;
  views: ViewCache;
  heartbeats: HeartbeatCache;
  starkscan: StarkscanClient;
  chain: string;
  pool: string;
}

export function createHandlers(deps: HandlerDeps) {
  const { db, events, views, heartbeats, starkscan, chain, pool } = deps;
  const tokenMeta = new TokenMetaCache(db);
  const avnu = new AvnuTokenIndex();

  /**
   * Data-freshness signal — the thing that was missing when the live feed
   * silently froze for 20h. Derived from the sync_state row's updated_at
   * (loop liveness) and the newest cached event. Cheap; no external calls.
   */
  function freshness(): Freshness {
    const sync = events.readSyncState(chain, pool);
    const lastSyncAt = sync?.updatedAt ?? null;
    const ageMs = lastSyncAt != null ? Date.now() - lastSyncAt : null;
    return {
      lastSyncAt,
      lastSyncAgeSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
      lastEventAt: events.newestEventIso(chain, pool),
      cachedHeadBlock: events.latestBlock(chain, pool),
      backfillComplete: sync?.backfillComplete ?? false,
      stale: ageMs == null || ageMs > STALE_AFTER_MS,
    };
  }

  return {
    /** Liveness + sync state + data freshness. */
    async health() {
      const f = freshness();
      return {
        ok: true,
        service: "strk20-dashboard-api",
        chain,
        pool,
        cachedEvents: f.cachedHeadBlock,
        freshness: f,
        rateLimit: starkscan.getRateLimitState(),
      };
    },

    /**
     * Chain status (head block, indexer lag) merged with our own sync
     * freshness, so a single call reveals whether the indexer is keeping up.
     * Starkscan's status is cached 5s; if it's unreachable we still return our
     * local freshness rather than throwing.
     */
    async status() {
      const key = `status:${chain}`;
      type Status = Awaited<ReturnType<typeof starkscan.status>>;
      let chainStatus = views.get<Status>(key);
      const wasCached = chainStatus != null;
      if (!chainStatus) {
        try {
          chainStatus = await starkscan.status();
          views.put(key, chainStatus, 5_000);
        } catch {
          chainStatus = null; // upstream down — fall back to local freshness only
        }
      }
      const f = freshness();
      const headLagBlocks =
        chainStatus?.headBlockNumber != null && f.cachedHeadBlock != null
          ? chainStatus.headBlockNumber - f.cachedHeadBlock
          : null;
      return {
        ...(chainStatus ?? {}),
        _cached: wasCached,
        chainStatusAvailable: chainStatus != null,
        cachedHeadBlock: f.cachedHeadBlock,
        headLagBlocks,
        lastSyncAt: f.lastSyncAt,
        lastSyncAgeSeconds: f.lastSyncAgeSeconds,
        lastEventAt: f.lastEventAt,
        stale: f.stale || (headLagBlocks != null && headLagBlocks > STALE_LAG_BLOCKS),
      };
    },

    /** Incremental sync of pool events into the cache. */
    async sync(opts: { pageSize?: number; maxPages?: number } = {}) {
      return syncContractEvents(starkscan, events, chain, pool, opts);
    },

    /** Anonymity set (created notes − spent notes). */
    async anonymitySet() {
      return anonymitySet(db, chain, pool);
    },

    /** Private operation count in window (default 24h). */
    async privateOps(opts: { windowMs?: number } = {}) {
      const window = opts.windowMs ?? DAY_MS;
      return privateOpsSince(db, chain, pool, Date.now() - window);
    },

    /**
     * Windowed deposit + withdrawal counts (drawn from windowStats — the
     * same source the 24h figures on pool-summary use). Activities panel on
     * the dashboard fans this out as the live portion of "Most frequent
     * activities" for a 30D window. Cached 30s per window.
     */
    /** All-time swap/stake/lend volumes + private-transfer count.
     *  Cached 60s — full event scan per compute. */
    async lifetimeConversions() {
      const key = `lifetime-conversions:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = lifetimeConversions(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Daily TVL from Starkscan-indexed flows, with today's endpoint pinned to
     *  Starkscan's finalized Privacy Pool snapshot. Cached 60s. */
    async tvlHistory() {
      const tvl = await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const key = `tvl-history:v3:${chain}:${pool}`;
      let history = views.get<ReturnType<typeof tvlHistory>>(key);
      if (!history) {
        history = tvlHistory(db, chain, pool);
        views.put(key, history, 60_000);
      }
      // Cache the expensive historical reconstruction, never the live tail.
      // A new response is pinned to the shared current-TVL snapshot every time.
      const days = [...history.days];
      const last = days[days.length - 1];
      if (last) days[days.length - 1] = { ...last, tvlUsd: tvl.totalUsd };
      const result = {
        ...history,
        days,
        source: "starkscan-events+starkscan-finalized",
        tvlSource: tvl.tvlSource,
        tvlAsOf: tvl.tvlAsOf,
        tvlAsOfBlock: tvl.tvlAsOfBlock,
      };
      return result;
    },

    /** Per-token shielded balance, daily — the breakdown behind tvl-history.
     *  Drives the Shielded Balance stacked-bar chart (with hover totals).
     *  Today's stack is pinned to Starkscan's finalized snapshot. Cached 60s. */
    async shieldedBalance() {
      const tvl = await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const key = `shielded-balance:v3:${chain}:${pool}`;
      let history = views.get<ReturnType<typeof shieldedBalance>>(key);
      if (!history) {
        history = shieldedBalance(db, chain, pool);
        views.put(key, history, 60_000);
      }
      const days = [...history.days];
      const last = days[days.length - 1];
      let tokens = [...history.tokens];
      if (last) {
        const byToken: Record<string, number> = {};
        for (const token of tvl.perToken) {
          if (token.balanceUsd <= 0) continue;
          byToken[token.symbol] = (byToken[token.symbol] ?? 0) + token.balanceUsd;
        }
        days[days.length - 1] = { ...last, total: tvl.totalUsd, byToken };
        const latest = Object.keys(byToken).sort((a, b) => byToken[b]! - byToken[a]!);
        tokens = [...latest, ...history.tokens.filter((symbol) => !(symbol in byToken))];
      }
      const result = {
        ...history,
        days,
        tokens,
        source: "starkscan-events+starkscan-finalized",
        tvlSource: tvl.tvlSource,
        tvlAsOf: tvl.tvlAsOf,
        tvlAsOfBlock: tvl.tvlAsOfBlock,
      };
      return result;
    },

    /** Privately routed volume by protocol (avnu/ekubo/vesu…), daily.
     *  Powers the "private actions per DeFi" stacked-bar chart. Cached 60s. */
    async routedVolume() {
      const key = `routed-volume:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const result = routedVolume(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Private swap volume per token (AVNU), daily — the per-token swap chart.
     *  Cached 60s. */
    async swapVolumeByToken() {
      const key = `swap-by-token:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const result = swapVolumeByToken(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Private actions (count) by protocol (avnu/ekubo/vesu), daily. Cached 60s. */
    async actionsByProtocol() {
      const key = `actions-by-protocol:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = actionsByProtocol(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Pool transactions per day (distinct tx hashes). Cached 60s. */
    async transactionsPerDay() {
      const key = `transactions-per-day:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = transactionsPerDay(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** User registrations per day (first ViewingKeySet per address), with
     *  running user total. The pool's user-growth curve. Cached 60s. */
    async registrations() {
      const key = `registrations:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = registrationsPerDay(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Daily active users — distinct addresses that shielded (Deposit) each UTC
     *  day, plus the all-time distinct total. Engagement counterpart to the
     *  registrations growth curve. Cached 60s. */
    async activeUsersPerDay() {
      const key = `active-users-per-day:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = activeUsersPerDay(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Deposit activity grouped by wallet family (account class hash).
     *  Wallets resolve via the wallet-classify sweep; until it finishes a
     *  "pending" bucket shrinks toward zero. Cached 5m. */
    async walletFamilies() {
      const key = `wallet-families:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = walletFamilies(db, chain, pool);
      views.put(key, result, 5 * 60_000);
      return result;
    },

    /** Daily volume by category (shielded in/out, swap, stake, lend),
     *  for the Volume stacked-bars chart. Cached 60s. */
    async volumeHistory() {
      const key = `volume-history:v2:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = volumeHistory(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    async windowOps(opts: { windowMs?: number } = {}) {
      const window = opts.windowMs ?? DAY_MS;
      const key = `window-ops:${chain}:${pool}:${window}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const w = windowStats(db, chain, pool, Date.now() - window);
      const conv = windowConversions(db, chain, pool, Date.now() - window);
      const result = {
        windowMs: window,
        deposits: w.deposits,
        withdrawals: w.withdrawals,
        // In-pool conversions (cross-token round-trip txs): see
        // windowConversions for the footprint heuristic + caveats.
        swaps: conv.swaps,
        stakes: conv.stakes,
        lends: conv.lends,
      };
      views.put(key, result, 30_000);
      return result;
    },

    /** Active depositor count in window (default 24h). Addresses omitted by default. */
    async activeDepositors(opts: { windowMs?: number; withAddresses?: boolean } = {}) {
      const window = opts.windowMs ?? DAY_MS;
      const result = activeDepositorsSince(db, chain, pool, Date.now() - window);
      return opts.withAddresses ? result : { count: result.count };
    },

    /** Distinct depositors across all-time. */
    async distinctDepositors() {
      return distinctDepositorsAllTime(db, chain, pool);
    },

    /** Note age distribution (Fresh / Young / Mature / Veteran). */
    async noteAges() {
      return noteAgeBuckets(db, chain, pool);
    },

    /** Starkscan finalized Privacy Pool TVL + explorer quotes. Cached 60s. */
    async tvl() {
      return currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
    },

    /** All-in-one headline metrics for the constellation centerpiece. */
    async poolSummary() {
      const tvl = await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const depositors = distinctDepositorsAllTime(db, chain, pool);
      const anon = anonymitySet(db, chain, pool);
      const w = windowStats(db, chain, pool, Date.now() - DAY_MS);
      const f = freshness();
      return {
        tvlUsd: tvl.totalUsd,
        tvlSource: tvl.tvlSource,
        tvlAsOfBlock: tvl.tvlAsOfBlock,
        tvlAsOf: tvl.tvlAsOf,
        depositCount: tvl.depositCount,
        withdrawalCount: tvl.withdrawalCount,
        userCount: depositors.count,
        anonymitySetUnspent: anon.unspent,
        partial: tvl.partial,
        unpricedTokenCount: tvl.unpricedTokenCount,
        priceCoverageComplete: tvl.priceCoverageComplete,
        perToken: tvl.perToken,
        deposits24h: w.deposits,
        withdrawals24h: w.withdrawals,
        tvlChangeUsd24h: w.tvlChangeUsd,
        // Freshness so the centerpiece fetch alone can drive a "data stale" banner.
        dataAsOf: f.lastEventAt,
        lastSyncAgeSeconds: f.lastSyncAgeSeconds,
        stale: f.stale,
      };
    },

    /**
     * Per-token flows in a window + center aggregate stats. Drives the
     * L2Beat-adapted hero chart. Window is whitelisted to {1h, 24h, 7d}.
     * Cached 30s per window.
     */
    async flowsGraph(opts: { window?: FlowsGraphWindow } = {}) {
      const win = opts.window ?? "7d";
      if (!(win in FLOWS_GRAPH_WINDOWS_MS)) {
        throw new Error(`window must be one of: ${Object.keys(FLOWS_GRAPH_WINDOWS_MS).join(", ")}`);
      }
      const windowMs = FLOWS_GRAPH_WINDOWS_MS[win];
      const key = `flows-graph:${chain}:${pool}:${win}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = await flowsGraph(db, chain, pool, windowMs, {
        currentTvl: async () => {
          const t = await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
          return {
            totalUsd: t.totalUsd,
            perToken: t.perToken.map((p) => ({
              address: p.address,
              symbol: p.symbol,
              decimals: p.decimals,
              balanceUsd: p.balanceUsd,
              priced: p.priced,
            })),
          };
        },
        anonymitySetUnspent: () => anonymitySet(db, chain, pool).unspent,
      });
      views.put(key, result, 30_000);
      return result;
    },

    /**
     * Withdrawal-broadcaster concentration (HHI + top share). Surfaces the
     * paymaster-centralization dimension of the pool's privacy architecture.
     * Cheap; not cached.
     */
    async relayerConcentration() {
      return relayerConcentration(db, chain, pool);
    },

    /**
     * Indexer uptime history derived from sync heartbeats. Returns one entry
     * per UTC day (oldest → newest) with ok/degraded/incident/unknown plus
     * the heartbeat-weighted aggregate percentage. Cached 60s.
     *
     * Once Uptime Kuma is deployed and pointed at /health, swap the body to
     * fetch Kuma's status-page heartbeats instead — same UptimeHistory shape,
     * frontend doesn't change.
     */
    /** Contract uptime since launch (Paused/Unpaused events). The old
     *  heartbeat-based metric remains at indexerUptime for ops use. */
    async contractUptime() {
      const key = `contract-uptime:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = contractUptime(db, chain, pool);
      views.put(key, result, 5 * 60_000);
      return result;
    },

    async uptimeHistory(opts: { days?: number } = {}) {
      const days = Math.max(1, Math.min(365, opts.days ?? 90));
      const key = `uptime-history:${days}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = uptimeHistory(heartbeats, days);
      views.put(key, result, 60_000);
      return result;
    },

    /**
     * Latest Deposit + Withdrawal events from the cache. Privacy-curated:
     * depositor address and encrypted recipient blob are NOT emitted; the
     * client renders those as "[private]". Cached 5s — fresh enough to feel
     * live without pummeling the cache on every poll.
     */
    async recentTransactions(opts: { limit?: number } = {}) {
      const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
      const key = `recent-tx:${chain}:${pool}:${limit}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = { transactions: recentTransactions(db, chain, pool, limit) };
      views.put(key, result, 5_000);
      return result;
    },

    /**
     * All-time USD volume processed (deposits + withdrawals). Priced via the
     * static token registry. Cached 60s — the scan walks every cached event.
     */
    /**
     * Lifetime protocol revenue. fee_per_apply_actions × number of
     * apply_actions calls (≈ distinct tx hashes in our event cache),
     * priced in STRK then USD via the static token registry. Cached 60s
     * because it walks every cached event for the distinct-tx count. */
    async lifetimeRevenue() {
      const key = `lifetime-revenue:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = lifetimeRevenue(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    async lifetimeVolume() {
      const key = `lifetime-volume:${chain}:${pool}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const result = lifetimeVolume(db, chain, pool);
      views.put(key, result, 60_000);
      return result;
    },

    /** Per-protocol routed activity (AVNU, Vesu, Endur, Ekubo, Troves). */
    async activeProtocols() {
      return { protocols: activeProtocols(db, chain, pool) };
    },

    /** Top callers by event volume — empirical discovery for curating the address book. */
    async topCallers(opts: { limit?: number } = {}) {
      const limit = Math.min(opts.limit ?? 25, 100);
      return { callers: topCallers(db, chain, pool, limit) };
    },

    /** Event count breakdown by decoded kind. */
    async eventBreakdown() {
      const counts: Record<string, number> = {};
      for (const [name, sel] of Object.entries(EVENT_SELECTORS)) {
        counts[name] = events.countByTopic(chain, pool, sel);
      }
      return { byKind: counts };
    },

    /** Sample of recent decoded events, optionally filtered by kind. */
    async eventSample(opts: { kind?: string; limit?: number } = {}) {
      const limit = Math.min(opts.limit ?? 5, 20);
      const sel =
        opts.kind && opts.kind in EVENT_SELECTORS
          ? EVENT_SELECTORS[opts.kind as keyof typeof EVENT_SELECTORS]
          : null;
      const sql = sel
        ? `SELECT * FROM raw_events WHERE chain=? AND contract=? AND topic0=? ORDER BY block_number DESC LIMIT ?`
        : `SELECT * FROM raw_events WHERE chain=? AND contract=? ORDER BY block_number DESC LIMIT ?`;
      const rows = sel
        ? (db.prepare(sql).all(chain, pool, sel, limit) as unknown as DbEventRow[])
        : (db.prepare(sql).all(chain, pool, limit) as unknown as DbEventRow[]);
      const decoded = rows.map((r) => decodeEvent(rowToRaw(r, pool)));
      return {
        decoded: decoded.map((e) => ({
          ...e,
          ...("amount" in e ? { amount: e.amount.toString() } : {}),
          ...("feeAmount" in e ? { feeAmount: e.feeAmount.toString() } : {}),
          ...("proofValidityBlocks" in e
            ? { proofValidityBlocks: e.proofValidityBlocks.toString() }
            : {}),
        })),
      };
    },

    /** Decoded event selector map (topic0 → event name). */
    async eventSelectors() {
      return EVENT_SELECTORS;
    },

    /** Raw event count by topic0 hash. */
    async eventCountByTopic(topic0: string) {
      return { topic0, count: events.countByTopic(chain, pool, topic0) };
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

interface DbEventRow {
  block_number: number;
  tx_hash: string;
  tx_index: number;
  log_index: number;
  timestamp_iso: string;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data_json: string;
}

function rowToRaw(r: DbEventRow, pool: string): RawContractEvent {
  return {
    blockNumber: r.block_number,
    txHash: r.tx_hash,
    txIndex: r.tx_index,
    logIndex: r.log_index,
    timestampIso: r.timestamp_iso,
    address: pool,
    topic0: r.topic0,
    topic1: r.topic1,
    topic2: r.topic2,
    topic3: r.topic3,
    data: JSON.parse(r.data_json) as string[],
  };
}
