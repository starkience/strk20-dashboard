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
4. **Run the sync once** to backfill events:
   ```bash
   curl -X POST http://localhost:3000/api/strk20/sync
   ```
   Repeat periodically (or wire a cron) to keep the cache fresh.
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

The default cache is SQLite (via `better-sqlite3`). To swap for Postgres or
something else, replace the `EventCache` / `ViewCache` implementations in
`@strk20/server/cache` with your own classes that expose the same methods, then
pass them to `createHandlers`.

## Notes

- `app/pool/page.tsx` is a Client Component (`"use client"`) because the
  dashboard components poll the API. If you want the page server-rendered, wrap
  the Dashboard with `dynamic(() => import("…"), { ssr: false })` instead.
- The catch-all API route runs in the Node runtime by default. `better-sqlite3`
  is a native module — confirm your Next.js project uses Node runtime, not Edge,
  for routes under `/api/strk20/*`.
- Don't expose `STARKSCAN_API_KEY` to the client — it must stay server-side.
