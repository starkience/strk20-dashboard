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
 *   - Address-keyed USD quotes come from Starkscan's explorer market feed,
 *     matching the prices used on starkscan.co/privacy-pool.
 *   - All registered pool tokens refresh together once per minute.
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
import {
  fetchStarkscanMarketSnapshot,
  resolveStarkscanPrice,
} from "./starkscan-market.js";

const DISCOVER_MS = 5 * 60_000;
const PRICE_REFRESH_MS = 60_000;

interface Opts {
  db: Db;
  starkscan: StarkscanClient;
  chain: string;
  pool: string;
}

export function startTokenSync({ db, starkscan, chain, pool }: Opts): void {
  const tokenMeta = new TokenMetaCache(db);
  const avnu = new AvnuTokenIndex();

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

  async function refreshPrices(): Promise<void> {
    const tokens = allTokens();
    if (tokens.length === 0) return;
    const market = await fetchStarkscanMarketSnapshot(tokens.map((token) => token.address));
    const updatedAt = Date.now();
    for (const token of tokens) {
      const quote = resolveStarkscanPrice(market, token.address, token.symbol);
      const usd = quote?.priceUsd ?? 0;
      // A null quote must clear a previously persisted price so every
      // aggregation follows Starkscan's current priced/unpriced decision.
      setTokenPrice(token.address, usd);
      upsertPrice.run(token.address, usd, updatedAt);
    }
  }

  for (const p of persisted) {
    // Registered tokens pick the price up immediately; tokens discovered
    // later re-read from this table via setTokenPrice after registration.
    setTokenPrice(p.address, p.usd);
  }

  void discover()
    .then(() => {
      // Apply persisted prices again now that discovery registered everything.
      for (const p of persisted) setTokenPrice(p.address, p.usd);
      console.log(`token-sync: ${allTokens().length} tokens registered`);
      return refreshPrices();
    })
    .catch((e) => console.error("token-sync discover failed:", e));

  setInterval(() => void discover().catch(() => {}), DISCOVER_MS);
  setInterval(() => void refreshPrices().catch(() => {}), PRICE_REFRESH_MS);
}
