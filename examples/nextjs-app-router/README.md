# Next.js App Router integration

Minimal example showing how to drop the STRK20 dashboard into a Next.js (App
Router) site.

## Files

- `app/pool/page.tsx` — renders `<Dashboard />` at `/pool`
- `app/api/strk20/[...path]/route.ts` — catch-all API route that mounts every
  `@strk20/server` handler at `/api/strk20/*`

## Setup steps

1. **Copy these two files** into your Next.js app at the same paths.
2. **Add the packages** to your app's `package.json`:
   ```json
   "dependencies": {
     "@strk20/core": "workspace:*",
     "@strk20/server": "workspace:*",
     "@strk20/dashboard": "workspace:*"
   }
   ```
   (If you're not in the strk20-dashboard monorepo, use file paths or publish
   the packages to a private registry.)
3. **Set env vars** in `.env.local`:
   ```
   STARKSCAN_BASE_URL=https://<starkscan-host>/api
   STARKSCAN_API_KEY=mzk_live_key_…
   STARKSCAN_CHAIN=SN_MAIN
   STRK20_POOL_ADDRESS=0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
   CACHE_DB_PATH=./data/strk20-cache.db
   ```
4. **Backfill the cache.** The standalone server (`pnpm dev:server`) auto-syncs
   on boot. In this catch-all-route setup there's no long-running boot, so kick
   the first backfill manually, then it stays warm:
   ```bash
   # repeat until eventsInserted is 0 (full history walk)
   curl -X POST http://localhost:3000/api/strk20/sync
   ```
   For production, run the standalone `@strk20/server` (which auto-backfills +
   polls) or wire a scheduled function to hit `/sync`.
5. **Open `/pool`** in your browser.

## Cherry-picking modules

If you don't want the whole dashboard, import the modules you need:

```tsx
"use client";
import {
  Strk20Provider,
  PoolConstellation,
  AnonymitySet,
} from "@strk20/dashboard";
import "@strk20/dashboard/style.css";

export default function CampaignHero() {
  return (
    <Strk20Provider apiUrl="/api/strk20">
      <section>
        <h2>Privacy pool right now</h2>
        <PoolConstellation />
        <AnonymitySet />
      </section>
    </Strk20Provider>
  );
}
```

## Bringing your own data

Each module accepts an optional `data` prop. If you'd rather fetch data via your
own GraphQL / cache / aggregation layer:

```tsx
import { PoolConstellation, type PoolConstellationData } from "@strk20/dashboard";

function MyVersion() {
  const data: PoolConstellationData = await fetchFromMyOwnLayer();
  return <PoolConstellation data={data} />;
}
```

Same for `<AnonymitySet data={…} />`, `<ShieldedTVL data={…} />`, etc.

## Replacing the SQLite cache

The default cache uses Node's built-in `node:sqlite` (no native build). To swap
for Postgres or something else, replace the `EventCache` / `ViewCache`
implementations in `@strk20/server/cache` with your own classes that expose the
same methods, then pass them to `createHandlers`.

## Notes

- `app/pool/page.tsx` is a Client Component (`"use client"`) because the
  dashboard components poll the API. If you want the page server-rendered, wrap
  the Dashboard with `dynamic(() => import("…"), { ssr: false })` instead.
- The catch-all API route must run in the **Node runtime** (not Edge) — it uses
  `node:sqlite`. Requires **Node 24**.
- Don't expose `STARKSCAN_API_KEY` to the client — it must stay server-side.
