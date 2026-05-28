/**
 * Catch-all Next.js API route that mounts every @strk20/server handler at
 * /api/strk20/*. Drop this file into your Next.js app and the dashboard's
 * `<Strk20Provider apiUrl="/api/strk20">` will work out of the box.
 *
 * If you'd rather have one route file per endpoint (more idiomatic Next.js),
 * import individual handlers from "@strk20/server/handlers" and wrap each
 * separately. This catch-all is the smallest possible integration.
 */

import { StarkscanClient } from "@strk20/core";
import { createHandlers } from "@strk20/server/handlers";
import { openCache, EventCache, ViewCache } from "@strk20/server/cache";

// Init once at module load (the route handler closure keeps these alive
// across requests in the same Node process).
const db = openCache(process.env.CACHE_DB_PATH ?? "./data/strk20-cache.db");
const events = new EventCache(db);
const views = new ViewCache(db);
const starkscan = new StarkscanClient({
  baseUrl: process.env.STARKSCAN_BASE_URL!,
  apiKey: process.env.STARKSCAN_API_KEY!,
  chain: process.env.STARKSCAN_CHAIN ?? "SN_MAIN",
});

const h = createHandlers({
  db,
  events,
  views,
  starkscan,
  chain: process.env.STARKSCAN_CHAIN ?? "SN_MAIN",
  pool: process.env.STRK20_POOL_ADDRESS!,
});

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Params) {
  const url = new URL(req.url);
  const { path } = await params;
  const route = "/" + path.join("/");

  switch (route) {
    case "/health":              return Response.json(await h.health());
    case "/status":              return Response.json(await h.status());
    case "/agg/anonymity-set":   return Response.json(await h.anonymitySet());
    case "/agg/private-ops":     return Response.json(await h.privateOps({
      windowMs: numQuery(url, "window_ms"),
    }));
    case "/agg/active-depositors": return Response.json(await h.activeDepositors({
      windowMs: numQuery(url, "window_ms"),
    }));
    case "/agg/distinct-depositors": return Response.json(await h.distinctDepositors());
    case "/agg/note-ages":       return Response.json(await h.noteAges());
    case "/agg/tvl":             return Response.json(await h.tvl());
    case "/agg/pool-summary":    return Response.json(await h.poolSummary());
    case "/agg/active-protocols": return Response.json(await h.activeProtocols());
    case "/agg/top-callers":     return Response.json(await h.topCallers({
      limit: numQuery(url, "limit"),
    }));
    case "/events/selectors":    return Response.json(await h.eventSelectors());
    case "/events/breakdown":    return Response.json(await h.eventBreakdown());
    case "/events/sample": {
      const kind = url.searchParams.get("kind");
      const limit = numQuery(url, "limit");
      return Response.json(await h.eventSample(kind ? { kind, limit } : { limit }));
    }
  }

  return Response.json({ error: "not found", route }, { status: 404 });
}

export async function POST(req: Request, { params }: Params) {
  const { path } = await params;
  const route = "/" + path.join("/");
  if (route === "/sync") return Response.json(await h.sync());
  return Response.json({ error: "not found", route }, { status: 404 });
}

function numQuery(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  return v == null ? undefined : Number(v);
}
