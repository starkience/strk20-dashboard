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
import { noteAgeBuckets } from "./aggregations/note-ages.js";
import { currentTvl } from "./aggregations/tvl.js";
import { activeProtocols, topCallers } from "./aggregations/protocols.js";
import { windowStats } from "./aggregations/window.js";
import { lifetimeVolume } from "./aggregations/lifetime-volume.js";
import {
  flowsGraph,
  FLOWS_GRAPH_WINDOWS_MS,
  type FlowsGraphWindow,
} from "./aggregations/flows-graph.js";
import { relayerConcentration } from "./aggregations/relayer-concentration.js";
import { recentTransactions } from "./aggregations/recent-transactions.js";
import { uptimeHistory } from "./aggregations/uptime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

  return {
    /** Liveness + sync state. */
    async health() {
      return {
        ok: true,
        service: "strk20-dashboard-api",
        chain,
        pool,
        cachedEvents: events.latestBlock(chain, pool),
        rateLimit: starkscan.getRateLimitState(),
      };
    },

    /** Chain status (head block, indexer lag). Cached 5s. */
    async status() {
      const key = `status:${chain}`;
      const cached = views.get<unknown>(key);
      if (cached) return { ...(cached as object), _cached: true };
      const fresh = await starkscan.status();
      views.put(key, fresh, 5_000);
      return fresh;
    },

    /** Incremental sync of pool events into the cache. */
    async sync(opts: { pageSize?: number; maxPages?: number } = {}) {
      return syncContractEvents(starkscan, events, chain, pool, {
        pageSize: opts.pageSize ?? 200,
        maxPages: opts.maxPages ?? 50,
      });
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
    async windowOps(opts: { windowMs?: number } = {}) {
      const window = opts.windowMs ?? DAY_MS;
      const key = `window-ops:${chain}:${pool}:${window}`;
      const cached = views.get<unknown>(key);
      if (cached) return cached;
      const w = windowStats(db, chain, pool, Date.now() - window);
      const result = {
        windowMs: window,
        deposits: w.deposits,
        withdrawals: w.withdrawals,
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

    /** Live TVL via on-chain token balances. Cached 60s server-side. */
    async tvl() {
      return currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
    },

    /** All-in-one headline metrics for the constellation centerpiece. */
    async poolSummary() {
      const tvl = await currentTvl(starkscan, db, views, tokenMeta, avnu, chain, pool);
      const depositors = distinctDepositorsAllTime(db, chain, pool);
      const anon = anonymitySet(db, chain, pool);
      const w = windowStats(db, chain, pool, Date.now() - DAY_MS);
      return {
        tvlUsd: tvl.totalUsd,
        depositCount: tvl.depositCount,
        withdrawalCount: tvl.withdrawalCount,
        userCount: depositors.count,
        anonymitySetUnspent: anon.unspent,
        partial: tvl.partial,
        perToken: tvl.perToken,
        deposits24h: w.deposits,
        withdrawals24h: w.withdrawals,
        tvlChangeUsd24h: w.tvlChangeUsd,
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
