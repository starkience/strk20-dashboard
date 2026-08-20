/**
 * Standalone Hono server. Thin shell that mounts the framework-agnostic
 * handlers from ./handlers.ts onto HTTP routes.
 *
 * If you'd rather run the dashboard inside Next.js / Express / whatever,
 * skip this file and use `createHandlers` from "@strk20/server/handlers".
 * See examples/nextjs-app-router/.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { StarkscanClient } from "@strk20/core";
import { openCache, EventCache, ViewCache } from "./cache/index.js";
import { HeartbeatCache } from "./cache/heartbeats.js";
import { createHandlers } from "./handlers.js";
import { startTokenSync } from "./services/token-sync.js";
import { startVenueVerify } from "./services/venue-verify.js";
import { startWalletClassify } from "./services/wallet-classify.js";
import {
  backfillSwapPrices,
  coingeckoDailyPrices,
} from "./services/swap-price-backfill.js";

const BASE_URL = required("STARKSCAN_BASE_URL");
const API_KEY = required("STARKSCAN_API_KEY");
const CHAIN = process.env.STARKSCAN_CHAIN ?? "SN_MAIN";
const POOL = required("STRK20_POOL_ADDRESS");
const CACHE_PATH = process.env.CACHE_DB_PATH ?? "./data/cache.db";
// Railway (and most PaaS) inject PORT; API_PORT wins for local dev.
const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
const CORS_ORIGIN = process.env.API_CORS_ORIGIN ?? "*";

const db = openCache(CACHE_PATH);
const events = new EventCache(db);
const views = new ViewCache(db);
const heartbeats = new HeartbeatCache(db);

const starkscan = new StarkscanClient({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  chain: CHAIN,
});

const h = createHandlers({ db, events, views, heartbeats, starkscan, chain: CHAIN, pool: POOL });

const app = new Hono();
app.use("/*", cors({ origin: CORS_ORIGIN }));

app.get("/health", async (c) => c.json(await h.health()));
app.get("/status", async (c) => c.json(await h.status()));
app.post("/sync", async (c) => c.json(await h.sync()));

app.get("/agg/anonymity-set", async (c) => c.json(await h.anonymitySet()));
app.get("/agg/private-ops", async (c) => {
  const windowMs = Number(c.req.query("window_ms") ?? 24 * 60 * 60 * 1000);
  return c.json(await h.privateOps({ windowMs }));
});
app.get("/agg/window-ops", async (c) => {
  const windowMs = Number(c.req.query("window_ms") ?? 24 * 60 * 60 * 1000);
  return c.json(await h.windowOps({ windowMs }));
});
app.get("/agg/active-depositors", async (c) => {
  const windowMs = Number(c.req.query("window_ms") ?? 24 * 60 * 60 * 1000);
  return c.json(await h.activeDepositors({ windowMs }));
});
app.get("/agg/distinct-depositors", async (c) => c.json(await h.distinctDepositors()));
app.get("/agg/note-ages", async (c) => c.json(await h.noteAges()));
app.get("/agg/tvl", async (c) => c.json(await h.tvl()));
app.get("/agg/pool-summary", async (c) => c.json(await h.poolSummary()));
app.get("/agg/active-protocols", async (c) => c.json(await h.activeProtocols()));
app.get("/agg/lifetime-volume", async (c) => c.json(await h.lifetimeVolume()));
app.get("/agg/lifetime-revenue", async (c) => c.json(await h.lifetimeRevenue()));
app.get("/agg/lifetime-conversions", async (c) => c.json(await h.lifetimeConversions()));
app.get("/agg/tvl-history", async (c) => c.json(await h.tvlHistory()));
app.get("/agg/shielded-balance", async (c) => c.json(await h.shieldedBalance()));
app.get("/agg/routed-volume", async (c) => c.json(await h.routedVolume()));
app.get("/agg/swap-by-token", async (c) => c.json(await h.swapVolumeByToken()));
app.get("/agg/actions-by-protocol", async (c) => c.json(await h.actionsByProtocol()));
app.get("/agg/transactions", async (c) => c.json(await h.transactionsPerDay()));
app.get("/agg/registrations", async (c) => c.json(await h.registrations()));
app.get("/agg/active-users", async (c) => c.json(await h.activeUsersPerDay()));
app.get("/agg/wallet-families", async (c) => c.json(await h.walletFamilies()));
app.get("/agg/volume-history", async (c) => c.json(await h.volumeHistory()));
app.get("/agg/relayer-concentration", async (c) => c.json(await h.relayerConcentration()));
app.get("/agg/contract-uptime", async (c) => c.json(await h.contractUptime()));
app.get("/agg/uptime-history", async (c) => {
  const days = Number(c.req.query("days") ?? 90);
  return c.json(await h.uptimeHistory({ days }));
});
app.get("/agg/recent-transactions", async (c) => {
  const limit = Number(c.req.query("limit") ?? 20);
  return c.json(await h.recentTransactions({ limit }));
});
app.get("/agg/flows-graph", async (c) => {
  const window = (c.req.query("window") ?? "7d") as "1h" | "24h" | "7d";
  try {
    return c.json(await h.flowsGraph({ window }));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get("/agg/top-callers", async (c) => {
  const limit = Number(c.req.query("limit") ?? 25);
  return c.json(await h.topCallers({ limit }));
});

app.get("/events/selectors", async (c) => c.json(await h.eventSelectors()));
app.get("/events/breakdown", async (c) => c.json(await h.eventBreakdown()));
app.get("/events/count", async (c) => {
  const topic0 = c.req.query("topic0");
  if (!topic0) return c.json({ error: "topic0 required" }, 400);
  return c.json(await h.eventCountByTopic(topic0));
});
app.get("/events/sample", async (c) => {
  const kind = c.req.query("kind");
  const limit = Number(c.req.query("limit") ?? 5);
  return c.json(await h.eventSample(kind ? { kind, limit } : { limit }));
});

// hostname 0.0.0.0 is required on Railway/most PaaS: a localhost-bound
// server is invisible to the platform's healthcheck and public proxy
// (works locally, fails in the container otherwise).
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`strk20 server listening on 0.0.0.0:${info.port}`);
  console.log(`  chain=${CHAIN} pool=${POOL.slice(0, 10)}…`);
  console.log(`  cache=${CACHE_PATH}`);
});

// Auto-sync: backfill the full history on boot, then poll the head on an
// interval. Set BACKFILL_ON_START=false to skip the initial walk, or
// SYNC_INTERVAL_MS to tune the poll cadence. Non-blocking — the server serves
// immediately and the cache fills in as the walk progresses.
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 120_000);
const BACKFILL_ON_START = process.env.BACKFILL_ON_START !== "false";

// Single-flight guard: the boot backfill and the interval poll share one sync
// path that mutates the cursor in sync_state, so they must never run
// concurrently. A skipped tick is harmless — the next one catches up.
let syncInFlight = false;
async function runSyncOnce() {
  if (syncInFlight) return null;
  syncInFlight = true;
  try {
    return await h.sync();
  } finally {
    syncInFlight = false;
  }
}

async function runAutoSync() {
  // Register the periodic poll FIRST so that even if the boot backfill throws,
  // catch-up (and its heartbeats) still run for the life of the process. The
  // old ordering put this after the backfill loop, so a single backfill error
  // killed sync permanently and silently.
  setInterval(async () => {
    try {
      const r = await runSyncOnce();
      if (!r) return; // a sync was already in flight
      heartbeats.record(true, r.eventsInserted);
      if (r.eventsInserted > 0) {
        console.log(`sync[${r.phase}]: +${r.eventsInserted} (head ${r.lastBlock ?? "—"})`);
      }
    } catch (e) {
      heartbeats.record(false, 0, (e as Error).message);
      console.error("sync error:", (e as Error).message);
    }
  }, SYNC_INTERVAL_MS);

  if (!BACKFILL_ON_START) return;
  console.log("sync: backfilling history…");
  for (let pass = 1; ; pass++) {
    try {
      const r = await runSyncOnce();
      if (!r) break; // interval poll is running it; let that drive completion
      heartbeats.record(true, r.eventsInserted);
      console.log(
        `sync[${r.phase}] pass ${pass}: +${r.eventsInserted} (head ${r.lastBlock ?? "—"})`
      );
      if (r.backfillComplete || r.eventsInserted === 0) break;
    } catch (e) {
      // Bail out of the boot backfill but leave the interval running — it will
      // keep retrying from the persisted cursor.
      heartbeats.record(false, 0, (e as Error).message);
      console.error(`sync: backfill pass ${pass} failed:`, (e as Error).message);
      break;
    }
  }
  console.log("sync: backfill complete");
}

runAutoSync().catch((e) => console.error("auto-sync failed:", e));

// Token discovery + live USD pricing (Starkscan metadata and explorer quotes).
startTokenSync({ db, starkscan, chain: CHAIN, pool: POOL });

// Venue verification: one receipt fetch per round-trip tx upgrades
// inferred swaps to venue-confirmed swaps with venue-reported amounts.
const RPC_URL = process.env.STARKNET_RPC_URL ?? "https://rpc.starknet.lava.build";
startVenueVerify({ db, chain: CHAIN, pool: POOL, rpcUrl: RPC_URL });

// Wallet classification: one class-hash fetch per depositor address feeds
// the /agg/wallet-families breakdown (activity by wallet software).
startWalletClassify({ db, chain: CHAIN, pool: POOL, rpcUrl: RPC_URL });

// Repair swaps recorded before legs carried a trade-time USD value. Runs
// on a slow loop rather than once: token metadata (and its coingecko id)
// arrives asynchronously from token-sync, so a later pass can fill rows
// the first one had to skip. Once every row is priced this is a single
// indexed query that finds nothing.
const SWAP_PRICE_BACKFILL_MS = 30 * 60_000;
async function runSwapPriceBackfill(): Promise<void> {
  const filled = await backfillSwapPrices({
    db,
    chain: CHAIN,
    history: coingeckoDailyPrices(),
  });
  if (filled > 0) console.log(`swap-price-backfill: filled ${filled} legacy swap rows`);
}
setTimeout(() => {
  runSwapPriceBackfill().catch((e) =>
    console.error("swap-price-backfill:", (e as Error).message)
  );
  setInterval(() => {
    runSwapPriceBackfill().catch((e) =>
      console.error("swap-price-backfill:", (e as Error).message)
    );
  }, SWAP_PRICE_BACKFILL_MS);
}, 60_000);

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}
