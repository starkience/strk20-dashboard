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
  Abbot, CASH `Forge` and `Melt` debt events from its Shrine, and `Provide`,
  `Remove`, and `Reap` savings events from its Absorber. `TroveOpened`
  binds each debt event's Trove ID to a verified owner. These are action counts,
  not USD volume or current position balances. Mainnet addresses come from
  [Opus's contracts repo](https://github.com/lindy-labs/opus_contracts#addresses).
  Debt events before a verified ownership record are excluded from both rows.
  The current collateral endpoint covers borrowing Troves; Absorber savings
  actions are included in the action chart, but its CASH balances are a
  separate asset and are not folded into the collateral figure.
- Supervega sums `premiumUsd` on `buy` records in its
  [public mainnet activity feed](https://supervega.app/api/activity?chain=mainnet).
  The separate action series counts both purchases and exercises; exercise
  records do not add another purchase premium.
- ArcX sums USDC `quoteRaw` once per fill across its
  [market catalogue](https://arcx-prod-strategy-cf.d.karnot.xyz/api/ct-markets)
  and every fills cursor. A fill involving either shadow-account counterparty
  belongs to the private slice. The action series additionally scans ERC20
  transfers on every vToken discovered from ArcX's onchain Registry, so
  shadow-account vault deposits, withdrawals, and share transfers appear as
  actions. vToken transfers have no inferred USD value and do not alter the
  USDC fills card.

Each app also reports `privateDays`, a daily series in that app's own unit.
Opus's series is actions; Supervega and ArcX are USD. Supervega and ArcX
also report `privateActionDays` for option purchases/exercises and ArcX fills
plus registered vToken transfers,
respectively. USD and action counts use separate chart axes.

`GET /agg/opus-collateral` reports current Opus Shrine collateral value in
USD. It reads the Shrine's finalized aggregate health and the health of Troves
opened by verified STRK20 shadow accounts at the same block. `private` sums
those Troves' collateral; `public` is the Shrine total less that amount. The
endpoint also exposes outstanding CASH debt for each slice. This is a current
collateral stock, distinct from Opus's gross action counts and from the broader
protocol TVL reported by DefiLlama. It is not added to the daily flow chart.

`GET /agg/troves-shadow-tvl` values STRK20 shadow-account positions in all
catalogued vault contracts. It indexes both vault actions and ERC20 share
transfers, including shares sent to a deterministic shadow address before its
deployment. It reads each candidate account's finalized vault share balance and
the vault's total share supply. Single-asset USDC/USDC.e/USDT vaults use
finalized `total_assets` and a current address-keyed token quote; this avoids
undervaluing a newly minted position while Troves's catalogue TVL lags.
Plain ETH/WBTC/STRK vaults use the same finalized asset method.
Other vaults use the USD TVL in
[Troves's strategy catalogue](https://app.troves.fi/api/strategies), because
their strategy assets need more than a spot-token quote.
The public row is the measured tracked-vault TVL less the private slice.
The separate `/agg/troves-shadow-activity` endpoint supplies daily vault action
counts. TVL is a current stock, so it does not belong in a daily volume chart.

`GET /agg/ekubo-lp-tvl` queries Ekubo's open LP NFTs for every indexed STRK20
shadow account and values their current liquidity from pool price, position
bounds, and current token quotes. The private row sums those positions; the
public row subtracts them from DefiLlama's Starknet Ekubo TVL. Ekubo swaps
remain in the separate routed-volume chart. Uncollected LP fees and positions
owned by another account or staking contract are outside this LP snapshot.

`GET /agg/endur-shadow-tvl` reports a matched current TVL split for Endur.
It values Endur liquid staking tokens held by the STRK20 pool from a finalized
pool balance and current address-keyed market quotes. That balance is the
private row; the public row subtracts it from Endur protocol TVL reported by
DefiLlama. It excludes Endur positions held outside the STRK20 pool, and it
does not use cumulative routed staking volume as a TVL proxy. Missing or stale
source values make the split unavailable rather than silently treating an
unpriced position as zero.

The endpoint serves no numeric value until it has a complete read from each
source and the shadow deployment history. Values age out after ten minutes if a
source stops responding. App feeds are partner-operated, so a changed response
shape makes that app unavailable rather than reporting a false zero.
