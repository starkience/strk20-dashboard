# Integration guide

How to plug the STRK20 dashboard into a site you own. Read this once before
touching the code.

## What's in this repo

Three packages, in `packages/`:

| Package | What it is | Who imports it |
|---|---|---|
| `@strk20/core` | Pure data layer — Starkscan client, event decoder, token & protocol registries. No React, no server framework. | The server, the dashboard, and your own server code. |
| `@strk20/server` | Cache + aggregations + framework-agnostic request handlers. Includes a standalone Hono server. | Your Next.js API route, or run as-is. |
| `@strk20/dashboard` | React components + data hooks. Each module is independently importable. | Your frontend pages. |

Plus `examples/nextjs-app-router/` — a working integration you can copy.

## Two integration patterns

### A. Standalone (run our Hono server alongside your site)

Pick this if you want zero changes to your existing site beyond pointing at a
new API URL.

```bash
# In this repo:
cp .env.example .env   # fill in STARKSCAN_API_KEY
pnpm install
pnpm dev:server        # API on :8787

# In your Next.js site:
import { Dashboard, Strk20Provider } from "@strk20/dashboard";
<Strk20Provider apiUrl="https://your-deploy.example.com:8787">
  <Dashboard />
</Strk20Provider>
```

Deploy the server (Hono, Node 24) wherever you like. It needs:
- `STARKSCAN_API_KEY` env
- Persistent disk for the SQLite cache (or override `CACHE_DB_PATH`)
- Nothing else — it **auto-syncs**: backfills the full history on boot, then polls the head every `SYNC_INTERVAL_MS` (default 2 min). No cron required.

### B. Embedded in your Next.js app (recommended)

Pick this if you want one deployment, no separate service, full ownership.

See `examples/nextjs-app-router/` — copy the two files into your app:

- `app/pool/page.tsx` — the dashboard page
- `app/api/strk20/[...path]/route.ts` — catch-all API route that mounts every handler

Set the same env vars in your `.env.local`. The dashboard hits `/api/strk20/*`
inside your own app instead of an external service.

## What Akash gets to choose

**Layout level (UI):**
- Drop in `<Dashboard />` for the full thing
- Or cherry-pick: `<PoolOverview />`, `<AnonymitySet />`, `<ShieldedTVL />`, `<NoteAgeHistogram />`, `<PrivateOperations />`, `<ActiveDepositors />`, `<VisibilityTable />`
- Each module takes an optional `data={…}` prop if he wants to pipe in his own data source

**Data level (server):**
- Use our handlers as-is via `createHandlers({ … })`
- Or import individual aggregation functions and wrap them however he wants:
  ```ts
  import { anonymitySet } from "@strk20/server/aggregations";
  import { currentTvl } from "@strk20/server/aggregations";
  ```
- Or swap the SQLite cache for Postgres by implementing `EventCache` / `ViewCache` interfaces

**Storage level:**
- SQLite by default (single file, zero ops)
- Override `CACHE_DB_PATH` to put it on persistent disk
- Or swap the cache implementation (see above)

## Sync strategy

**Automatic.** On boot the server backfills the full event history (two-phase:
walks newest→oldest until done, persisting a cursor so restarts don't re-walk),
then polls the head every `SYNC_INTERVAL_MS` (default 2 min). The dashboard
fills in as the backfill progresses — a busy contract can take several minutes
for the first full walk, self-throttled against the Starkscan rate limit.

Controls:
- `BACKFILL_ON_START=false` — skip the initial walk (head-only)
- `SYNC_INTERVAL_MS` — poll cadence
- `POST /sync` still exists for a manual nudge

Embedded in Next.js, the catch-all route's module-load init kicks off the same
backfill the first time the route is hit. (For serverless you may prefer a
dedicated long-running server or a scheduled function — see notes below.)

## Prerequisites

- **Node 24** (`.nvmrc`) — the cache uses the built-in `node:sqlite`, so there's
  **no native build step and no C toolchain required**.
- **pnpm** — the workspace uses the `workspace:*` protocol (npm/yarn won't resolve it).

TVL (the most live metric) is computed from on-chain `balance-of` queries with a
60s server-side cache, so it stays fresh independent of event sync cadence.

## Address book curation (important before launch)

`packages/core/src/protocols/addresses.ts` ships with empty address arrays for
AVNU / Vesu / Endur / Ekubo / Troves. Until they're curated, the constellation
satellites are decorative (no activity flows).

To curate:
1. Run `GET /agg/top-callers` to see the top addresses interacting with the pool
2. Cross-reference each address (Voyager, project docs, etc.) to identify the protocol
3. Drop the address into the corresponding entry in `addresses.ts` and set `needsCuration: false`
4. Satellites auto-light-up — no rebuild needed (just restart the server)

## Pricing (important before launch)

USD prices in `packages/core/src/tokens/registry.ts` are **hardcoded
approximations**. Before launch, swap them for a live price feed. Two options:

- **CoinGecko free tier:** ~50 req/min, no auth needed. Cache results 5 min.
- **Pyth on Starknet:** on-chain prices, no external API.

Each token has a `coingeckoId` field already; wire a small fetcher in the server
that overrides `usdApprox` per-poll.

## What's not yet built

- Live event feed (SSE pipeline + `<LiveFeed />` component) — planned
- Published npm packages — currently workspace-only; publish to private registry if you want non-monorepo installs
- Migration tooling for cache schema changes — currently the schema is appended-only via `CREATE TABLE IF NOT EXISTS`

## Where things live

```
strk20-dashboard/
├── packages/core/           ← data layer (no framework)
├── packages/server/         ← cache + aggregations + handlers + optional Hono server
├── packages/dashboard/      ← React components + data hooks
└── examples/                ← integration patterns to copy from
    └── nextjs-app-router/
```
