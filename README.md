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

TVL uses the finalized amounts and prepared asset valuations from the same
public snapshot as Starkscan's Privacy Pool page. The line and token breakdown
use its per-token metric series. Unpriced assets are excluded from the USD
subtotal; an unavailable source never triggers alternate TVL accounting.

## Before launch (curation tasks)

- Curate protocol addresses in `packages/core/src/protocols/addresses.ts` (use `/agg/top-callers` for empirical discovery)
- Set up periodic `POST /sync` cron to keep the event cache fresh

### Troves shadow-account activity

`GET /agg/troves-shadow-activity` reports finalized private vault transaction counts,
active shadow-account counts, daily counts, and deposit/withdrawal/request/claim
**event** counts. Transactions are deduplicated across vault events; shadow accounts
are pseudonymous accounts, not unique people. No private TVL or dollar volume is inferred.

The index discovers accounts from `ShadowAccountDeployed` on the mainnet shared
anonymizer `0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7`.
It matches position owners (or claim recipients) in vaults listed by
https://app.troves.fi/api/strategies. Public-account activity is excluded. The catalogue
currently has 38 vaults; strategies without a vault contract are listed under
`excludedStrategyIds`. Retired vaults remain indexed after catalogue removal.

Starkscan provides the raw events, finalized block bound, and ABI decoding. Exact
legacy Cairo layouts from Troves's public indexer/mainnet ABIs handle `name_only`
events. Unrecognized layouts produce `partial` coverage, never a claimed zero.
The independent cursor store resumes fixed finalized block ranges across restarts.
Clients should show numeric values only when `status` is `live`; `indexing`,
`partial`, and `stale` preserve the distinction between zero and unavailable coverage.
