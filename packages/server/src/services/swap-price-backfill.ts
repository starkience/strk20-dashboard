import { applyDecimals, lookupToken, normalizeHex } from "@strk20/core";
import type { Db } from "../cache/db.js";

/**
 * One-off repair for `venue_swaps` rows recorded before legs carried a
 * trade-time USD value (see venue-swap-store.ts). Those rows have raw
 * amounts but null sell_usd/buy_usd, so every read priced them at
 * whatever the token happened to cost that minute.
 *
 * We can't recover the exact execution price after the fact, but the
 * daily close on the trade day is far closer than today's spot — and it
 * stops moving, which is the whole point. Rows whose day has no
 * historical quote are left null and keep the live-price fallback.
 */

/** Resolves a token's daily close prices as { "YYYY-MM-DD": usd }. */
export type DailyPriceLookup = (coingeckoId: string) => Promise<Record<string, number> | null>;

export interface BackfillOpts {
  db: Db;
  chain: string;
  history: DailyPriceLookup;
}

interface PendingRow {
  tx_hash: string;
  evt_index: number;
  day: string;
  sell_token: string | null;
  sell_amount: string | null;
  buy_token: string | null;
  buy_amount: string | null;
  sell_usd: number | null;
  buy_usd: number | null;
}

/** Fills what it can and returns the number of rows updated. */
export async function backfillSwapPrices({ db, chain, history }: BackfillOpts): Promise<number> {
  const rows = db
    .prepare(
      `SELECT tx_hash, evt_index, day, sell_token, sell_amount, buy_token, buy_amount,
              sell_usd, buy_usd
         FROM venue_swaps
        WHERE chain = ?
          AND ((sell_usd IS NULL AND sell_token IS NOT NULL AND sell_amount IS NOT NULL)
            OR (buy_usd  IS NULL AND buy_token  IS NOT NULL AND buy_amount  IS NOT NULL))`
    )
    .all(chain) as unknown as PendingRow[];
  if (rows.length === 0) return 0;

  // One history fetch per coingecko id, shared across every row that needs it.
  const byId = new Map<string, Record<string, number> | null>();
  const pricesFor = async (token: string): Promise<Record<string, number> | null> => {
    const meta = lookupToken(normalizeHex(token));
    if (!meta?.coingeckoId) return null;
    if (!byId.has(meta.coingeckoId)) {
      try {
        byId.set(meta.coingeckoId, await history(meta.coingeckoId));
      } catch {
        byId.set(meta.coingeckoId, null);
      }
    }
    return byId.get(meta.coingeckoId) ?? null;
  };

  const legUsdOnDay = async (
    token: string | null,
    amount: string | null,
    day: string
  ): Promise<number | null> => {
    if (!token || !amount) return null;
    const meta = lookupToken(normalizeHex(token));
    if (!meta) return null;
    const price = (await pricesFor(token))?.[day];
    if (price == null || !(price > 0)) return null;
    try {
      return applyDecimals(BigInt(amount), meta.decimals) * price;
    } catch {
      return null;
    }
  };

  const update = db.prepare(
    `UPDATE venue_swaps SET sell_usd = ?, buy_usd = ?
      WHERE chain = ? AND tx_hash = ? AND evt_index = ?`
  );

  let filled = 0;
  for (const r of rows) {
    const sell = r.sell_usd ?? (await legUsdOnDay(r.sell_token, r.sell_amount, r.day));
    const buy = r.buy_usd ?? (await legUsdOnDay(r.buy_token, r.buy_amount, r.day));
    if (sell === r.sell_usd && buy === r.buy_usd) continue;
    update.run(sell, buy, chain, r.tx_hash, r.evt_index);
    filled += 1;
  }
  return filled;
}

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/**
 * Daily closes from CoinGecko. `days` without an explicit interval gives
 * daily granularity on the free tier for ranges over 90 days, which is
 * all the pool's swap history needs. Calls are spaced so a sweep of the
 * pool's dozen-odd tokens stays inside the public rate limit — the
 * backfill runs once and then finds nothing, so slow is fine.
 */
export function coingeckoDailyPrices(days = 365, gapMs = 2500): DailyPriceLookup {
  return async (coingeckoId) => {
    await new Promise((r) => setTimeout(r, gapMs));
    const url = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { prices?: [number, number][] };
    if (!Array.isArray(body.prices)) return null;
    const out: Record<string, number> = {};
    for (const [ms, usd] of body.prices) {
      out[new Date(ms).toISOString().slice(0, 10)] = usd;
    }
    return out;
  };
}
