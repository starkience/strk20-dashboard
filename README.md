# strk20-dashboard

Privacy pool dashboard for the STRK20 campaign (June 2026).

A monorepo Akash owns and hosts. Three packages he can mix and match.

## What's here

```
packages/
  core/         Pure data: Starkscan client, event decoder, token/protocol registries
  server/       Cache + aggregations + framework-agnostic handlers (+ optional Hono server)
  dashboard/    React components, modular and cherry-pickable

examples/
  nextjs-app-router/   Drop-in Next.js integration (page + API route)
```

## Quick start (local dev)

```bash
cp .env.example .env       # fill in STARKSCAN_API_KEY + STRK20_POOL_ADDRESS
nvm use                    # node 24
pnpm install
pnpm dev:server            # API on http://localhost:8787
pnpm dev:dashboard         # UI dev playground on http://localhost:5173
```

## Integration

See **[INTEGRATION.md](./INTEGRATION.md)** for the full guide. Short version:

**Embed in your Next.js site** (recommended) — copy the two files from
`examples/nextjs-app-router/` into your app. The Dashboard hits `/api/strk20/*`
inside your own deployment.

**Run as a separate service** — `pnpm dev:server` ships a standalone Hono
server. Your frontend points at it via `<Strk20Provider apiUrl="…">`.

## Module surface

```tsx
import {
  Dashboard,                  // all-in-one
  Strk20Provider,
  // Individual modules — each takes optional `data` prop:
  PoolConstellation,
  AnonymitySet,
  ShieldedTVL,
  PrivateOperations,
  ActiveDepositors,
  NoteAgeHistogram,
  VisibilityTable,
  // Data hooks if you want to read without rendering:
  usePoolConstellationData,
  useAnonymitySetData,
  // …
} from "@strk20/dashboard";
```

## Data source

Current TVL mirrors Starkscan: the authenticated Privacy Pool TVL endpoint is
the source for finalized token amounts and counts, and Starkscan's explorer
market feed supplies the address-keyed USD quotes. The balance/event-derived
calculation is used only when that authoritative snapshot is unavailable.

## Before launch (curation tasks)

- Curate protocol addresses in `packages/core/src/protocols/addresses.ts` (use `/agg/top-callers` for empirical discovery)
- Set up periodic `POST /sync` cron to keep the event cache fresh
