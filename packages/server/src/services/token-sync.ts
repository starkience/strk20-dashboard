/**
 * Token discovery + live USD pricing.
 *
 * Discovery (every DISCOVER_MS, and once at boot):
 *   - every distinct token address seen in pool Deposit/Withdrawal events
 *   - metadata resolved Starkscan-first: AVNU curated list → token_meta
 *     cache → Starkscan /token/{addr} → registered into the core registry
 *     so every aggregation (recent-transactions, TVL, volume, flows…)
 *     renders real symbols/decimals instead of "?" / wrong scales.
 *
 * Pricing (continuous):
 *   - Starkscan's API exposes no USD prices, so prices come from CoinGecko.
 *   - One token per PRICE_TICK_MS via /simple/token_price/starknet
 *     (free tier allows a single contract address per call), always
 *     refreshing the stalest token first. ~5 calls/min stays comfortably
 *     inside CoinGecko's public rate limit; a full sweep of all pool
 *     tokens completes every few minutes.
 *   - Prices persist to the token_prices table so restarts resume with
 *     the last known price instead of $0.
 */

import {
  EVENT_SELECTORS,
  normalizeHex,
  registerToken,
  setTokenPrice,
  lookupToken,
  allTokens,
  AvnuTokenIndex,
  type StarkscanClient,
} from "@strk20/core";
import type { Db } from "../cache/db.js";
import { TokenMetaCache } from "../cache/tokens.js";

const DISCOVER_MS = 5 * 60_000;
const PRICE_TICK_MS = 12_000;
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

interface Opts {
  db: Db;
  starkscan: StarkscanClient;
  chain: string;
  pool: string;
}

export function startTokenSync({ db, starkscan, chain, pool }: Opts): void {
  const tokenMeta = new TokenMetaCache(db);
  const avnu = new AvnuTokenIndex();
  const priceUpdatedAt = new Map<string, number>();

  // Warm-start prices from the last run.
  const persisted = db
    .prepare(`SELECT address, usd, updated_at FROM token_prices`)
    .all() as { address: string; usd: number; updated_at: number }[];

  const upsertPrice = db.prepare(`
    INSERT INTO token_prices (address, usd, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
  `);

  async function discover(): Promise<void> {
    const rows = db
      .prepare(
        `SELECT DISTINCT topic2 AS token FROM raw_events
         WHERE chain=? AND contract=? AND topic2 IS NOT NULL
           AND topic0 IN (?, ?)`
      )
      .all(chain, pool, EVENT_SELECTORS.Deposit, EVENT_SELECTORS.Withdrawal) as {
      token: string;
    }[];

    try {
      await avnu.ensureLoaded();
    } catch {
      /* AVNU list unreachable — cache/Starkscan paths still work */
    }

    for (const r of rows) {
      const address = normalizeHex(r.token);
      const known = lookupToken(address);
      if (known) continue; // seeds + previously discovered

      // 1) AVNU curated list (symbol/decimals/coingeckoId)
      const a = avnu.get(address);
      if (a) {
        registerToken({
          address,
          symbol: a.symbol,
          name: a.name ?? a.symbol,
          decimals: a.decimals,
          usdApprox: 0,
          coingeckoId: a.coingeckoId,
        });
        continue;
      }

      // 2) persistent token_meta cache
      const cached = tokenMeta.get(address);
      if (cached?.symbol && cached.decimals != null) {
        registerToken({
          address,
          symbol: cached.symbol,
          name: cached.name ?? cached.symbol,
          decimals: cached.decimals,
          usdApprox: 0,
          coingeckoId: null,
        });
        continue;
      }

      // 3) Starkscan /token/{addr}
      try {
        const m = await starkscan.tokenMeta(address);
        if (m.symbol && m.decimals != null) {
          tokenMeta.put(address, {
            symbol: m.symbol,
            name: m.name,
            decimals: m.decimals,
          });
          registerToken({
            address,
            symbol: m.symbol,
            name: m.name ?? m.symbol,
            decimals: m.decimals,
            usdApprox: 0,
            coingeckoId: null,
          });
        }
      } catch {
        /* token stays unregistered; aggregations fall back to short address */
      }
    }
  }

  /** CoinGecko's Starknet platform keys tokens by 0x + 64-hex (zero-padded). */
  function padAddress(address: string): string {
    return "0x" + address.replace(/^0x/, "").padStart(64, "0");
  }

  async function priceTick(): Promise<void> {
    const tokens = allTokens();
    if (tokens.length === 0) return;
    // Stalest first, so new tokens get priced quickly and the whole set
    // stays uniformly fresh.
    tokens.sort(
      (a, b) =>
        (priceUpdatedAt.get(a.address) ?? 0) - (priceUpdatedAt.get(b.address) ?? 0)
    );
    const target = tokens[0];
    if (!target) return;
    // Mark attempted up front so an unpriceable token (not listed on
    // CoinGecko) rotates to the back instead of starving the others.
    priceUpdatedAt.set(target.address, Date.now());
    try {
      const padded = padAddress(target.address);
      const res = await fetch(
        `${COINGECKO_BASE}/simple/token_price/starknet?contract_addresses=${padded}&vs_currencies=usd`
      );
      if (!res.ok) return;
      const body = (await res.json()) as Record<string, { usd?: number }>;
      let usd = body[padded]?.usd ?? body[target.address]?.usd;

      // Not listed by contract (e.g. strkBTC) — fall back to the pegged
      // coingeckoId where one is known.
      if (usd == null && target.coingeckoId) {
        const idRes = await fetch(
          `${COINGECKO_BASE}/simple/price?ids=${target.coingeckoId}&vs_currencies=usd`
        );
        if (idRes.ok) {
          const idBody = (await idRes.json()) as Record<string, { usd?: number }>;
          usd = idBody[target.coingeckoId]?.usd;
        }
      }

      if (typeof usd === "number" && isFinite(usd) && usd > 0) {
        setTokenPrice(target.address, usd);
        upsertPrice.run(target.address, usd, Date.now());
      }
    } catch {
      /* network hiccup — next tick retries the same (still stalest) token */
    }
  }

  for (const p of persisted) {
    // Registered tokens pick the price up immediately; tokens discovered
    // later re-read from this table via setTokenPrice after registration.
    setTokenPrice(p.address, p.usd);
    priceUpdatedAt.set(p.address, p.updated_at);
  }

  void discover()
    .then(() => {
      // Apply persisted prices again now that discovery registered everything.
      for (const p of persisted) setTokenPrice(p.address, p.usd);
      console.log(`token-sync: ${allTokens().length} tokens registered`);
    })
    .catch((e) => console.error("token-sync discover failed:", e));

  setInterval(() => void discover().catch(() => {}), DISCOVER_MS);
  setInterval(() => void priceTick(), PRICE_TICK_MS);
}
