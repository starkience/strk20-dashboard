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
import { createHandlers } from "./handlers.js";

const BASE_URL = required("STARKSCAN_BASE_URL");
const API_KEY = required("STARKSCAN_API_KEY");
const CHAIN = process.env.STARKSCAN_CHAIN ?? "SN_MAIN";
const POOL = required("STRK20_POOL_ADDRESS");
const CACHE_PATH = process.env.CACHE_DB_PATH ?? "./data/cache.db";
const PORT = Number(process.env.API_PORT ?? 8787);
const CORS_ORIGIN = process.env.API_CORS_ORIGIN ?? "*";

const db = openCache(CACHE_PATH);
const events = new EventCache(db);
const views = new ViewCache(db);

const starkscan = new StarkscanClient({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  chain: CHAIN,
});

const h = createHandlers({ db, events, views, starkscan, chain: CHAIN, pool: POOL });

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
app.get("/agg/active-depositors", async (c) => {
  const windowMs = Number(c.req.query("window_ms") ?? 24 * 60 * 60 * 1000);
  return c.json(await h.activeDepositors({ windowMs }));
});
app.get("/agg/distinct-depositors", async (c) => c.json(await h.distinctDepositors()));
app.get("/agg/note-ages", async (c) => c.json(await h.noteAges()));
app.get("/agg/tvl", async (c) => c.json(await h.tvl()));
app.get("/agg/pool-summary", async (c) => c.json(await h.poolSummary()));
app.get("/agg/active-protocols", async (c) => c.json(await h.activeProtocols()));
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`strk20 server listening on http://localhost:${info.port}`);
  console.log(`  chain=${CHAIN} pool=${POOL.slice(0, 10)}…`);
  console.log(`  cache=${CACHE_PATH}`);
});

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}
