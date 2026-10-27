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

### Partner app flows

`GET /agg/app-flows` compares two disjoint slices for Opus, Supervega, and ArcX:
`public` excludes known STRK20 shadow accounts, while `private` counts activity
by accounts deployed through the STRK20 mainnet shadow anonymizer. Shadow
accounts are public pseudonyms; their app-side actions and amounts remain public.

- Opus counts finalized collateral `Deposit` and `Withdraw` events from its
  Abbot plus CASH `Forge` and `Melt` debt events from its Shrine. `TroveOpened`
  binds each debt event's Trove ID to a verified owner. These are action counts,
  not USD volume or current position balances. Mainnet addresses come from
  [Opus's contracts repo](https://github.com/lindy-labs/opus_contracts#addresses).
  Debt events before a verified ownership record are excluded from both rows.
- Supervega sums `premiumUsd` on `buy` records in its
  [public mainnet activity feed](https://supervega.app/api/activity?chain=mainnet).
  Exercise records do not add another purchase premium.
- ArcX sums USDC `quoteRaw` once per fill across its
  [market catalogue](https://arcx-prod-strategy-cf.d.karnot.xyz/api/ct-markets)
  and every fills cursor. A fill involving either shadow-account counterparty
  belongs to the private slice.

Each app also reports `privateDays`, a daily series in that app's own unit.
Opus's series is actions; Supervega and ArcX are USD. These different units
must not be stacked on the same chart axis.

`GET /agg/troves-shadow-tvl` values observed STRK20 shadow-account vault
positions. It reads each observed account's finalized vault share balance and
the vault's total share supply, then applies that fraction to the same vault's
USD TVL in [Troves's strategy catalogue](https://app.troves.fi/api/strategies).
The public row is the catalogue's tracked-vault TVL less the observed private
slice. The current scope includes shadow accounts seen in indexed Troves vault
activity; positions acquired solely by share transfer are not yet attributed.
The separate `/agg/troves-shadow-activity` endpoint supplies daily vault action
counts. TVL is a current stock, so it does not belong in a daily volume chart.

The endpoint serves no numeric value until it has a complete read from each
source and the shadow deployment history. Values age out after ten minutes if a
source stops responding. App feeds are partner-operated, so a changed response
shape makes that app unavailable rather than reporting a false zero.
