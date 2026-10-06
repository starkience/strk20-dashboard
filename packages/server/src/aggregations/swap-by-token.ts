import type { Db } from "../cache/db.js";
import { lookupToken, applyDecimals, normalizeHex } from "@strk20/core";

/**
 * Private swap volume, per traded asset and venue, daily.
 *
 * AVNU rows come from receipt-decoded venue swaps. Ekubo rows are
 * materialized from the dedicated STRK20 anonymizer's pool withdrawal and
 * open-note deposit legs. Stored trade-day USD values win; the live token
 * registry is only a fallback while a newly discovered row awaits the
 * historical-price backfill.
 */

const VENUES = ["avnu", "ekubo"];
const STABLE_SYMBOLS = new Set(["USDC", "USDC.E", "USDT", "DAI", "CASH", "USN", "SUSN"]);

export interface SwapByTokenDay {
  date: string; // YYYY-MM-DD (UTC)
  total: number; // USD == sum of byToken == sum of byVenue
  /** Traded asset symbol → USD swapped that day. */
  byToken: Record<string, number>;
  /** Private venue id → USD swapped that day. */
  byVenue: Record<string, number>;
  /** Private venue id → swaps that day. */
  swapsByVenue: Record<string, number>;
}

export interface SwapByToken {
  days: SwapByTokenDay[];
  tokens: string[]; // by overall volume desc — stack + legend order
  venues: string[];
  totalUsd: number;
  swapCount: number;
  totalsByVenue: Record<string, number>;
  swapCountByVenue: Record<string, number>;
  pricing: "stored-trade-day-with-live-fallback";
}

interface SwapRow {
  tx_hash: string;
  evt_index: number;
  day: string | null;
  venue: string;
  sell_token: string | null;
  sell_amount: string | null;
  buy_token: string | null;
  buy_amount: string | null;
  sell_usd: number | null;
  buy_usd: number | null;
}

interface Leg {
  token: string | null;
  amount: string | null;
  usd: number | null;
  symbol: string | null;
}

export function swapVolumeByToken(db: Db, chain: string, _pool: string): SwapByToken {
  const placeholders = VENUES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tx_hash, evt_index, day, venue,
              sell_token, sell_amount, buy_token, buy_amount, sell_usd, buy_usd
       FROM venue_swaps
       WHERE chain=? AND venue IN (${placeholders})`
    )
    .all(chain, ...VENUES) as unknown as SwapRow[];

  const byDayToken = new Map<string, Map<string, number>>();
  const byDayVenue = new Map<string, Map<string, number>>();
  const byDayVenueCount = new Map<string, Map<string, number>>();
  const totalsByVenue = zeroes(VENUES);
  const swapCountByVenue = zeroes(VENUES);
  const seenSwaps = new Set<string>();

  let totalUsd = 0;
  for (const row of rows) {
    if (!row.day) continue;
    const venue = row.venue.toLowerCase();
    // Receipt verification can identify an Ekubo Core event without decoding
    // its amounts. Only rows enriched from the dedicated STRK20 anonymizer
    // are private Ekubo swaps and belong in this dataset.
    if (venue === "ekubo" && (!row.sell_token || !row.sell_amount)) continue;
    const swapKey = `${venue}:${row.tx_hash}:${row.evt_index}`;
    if (!seenSwaps.has(swapKey)) {
      seenSwaps.add(swapKey);
      swapCountByVenue[venue] = (swapCountByVenue[venue] ?? 0) + 1;
      addNested(byDayVenueCount, row.day, venue, 1);
    }

    const sell = leg(row.sell_token, row.sell_amount, row.sell_usd);
    const buy = leg(row.buy_token, row.buy_amount, row.buy_usd);
    const usd = tradeUsd(sell, buy);
    const symbol = tradedAssetSymbol(sell, buy);
    if (usd == null || usd <= 0 || !symbol) continue;

    addNested(byDayToken, row.day, symbol, usd);
    addNested(byDayVenue, row.day, venue, usd);
    totalsByVenue[venue] = (totalsByVenue[venue] ?? 0) + usd;
    totalUsd += usd;
  }

  const swapCount = seenSwaps.size;
  const allDays = new Set([...byDayToken.keys(), ...byDayVenueCount.keys()]);
  if (allDays.size === 0) {
    return {
      days: [],
      tokens: [],
      venues: [...VENUES],
      totalUsd: 0,
      swapCount,
      totalsByVenue,
      swapCountByVenue,
      pricing: "stored-trade-day-with-live-fallback",
    };
  }

  const sorted = [...allDays].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: SwapByTokenDay[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const tokenMap = byDayToken.get(cur);
    const venueMap = byDayVenue.get(cur);
    const countMap = byDayVenueCount.get(cur);
    const byToken = tokenMap ? Object.fromEntries(tokenMap) : {};
    const byVenue = venueMap ? Object.fromEntries(venueMap) : {};
    const swapsByVenue = countMap ? Object.fromEntries(countMap) : {};
    const total = Object.values(byToken).reduce((sum, usd) => sum + usd, 0);
    days.push({ date: cur, total, byToken, byVenue, swapsByVenue });
  }

  const tokenTotals = new Map<string, number>();
  for (const d of days) {
    for (const [symbol, usd] of Object.entries(d.byToken)) {
      tokenTotals.set(symbol, (tokenTotals.get(symbol) ?? 0) + usd);
    }
  }
  const tokens = [...tokenTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([symbol]) => symbol);

  return {
    days,
    tokens,
    venues: [...VENUES],
    totalUsd,
    swapCount,
    totalsByVenue,
    swapCountByVenue,
    pricing: "stored-trade-day-with-live-fallback",
  };
}

function leg(token: string | null, amount: string | null, storedUsd: number | null): Leg {
  const meta = token ? lookupToken(normalizeHex(token)) : undefined;
  let usd = storedUsd != null && storedUsd > 0 ? storedUsd : null;
  if (usd == null && meta && amount && meta.usdApprox > 0) {
    try {
      usd = applyDecimals(BigInt(amount), meta.decimals) * meta.usdApprox;
    } catch {
      usd = null;
    }
  }
  return {
    token,
    amount,
    usd,
    symbol: token ? meta?.symbol || shortAddr(token) : null,
  };
}

/**
 * Prefer the stablecoin side when one exists. This values ZEC/USDC at the
 * actual USDC exchanged in either direction instead of rewriting historical
 * volume when ZEC's current price moves. Otherwise use the sell leg, with the
 * buy leg as the fallback.
 */
function tradeUsd(sell: Leg, buy: Leg): number | null {
  if (sell.symbol && STABLE_SYMBOLS.has(sell.symbol.toUpperCase()) && sell.usd != null) return sell.usd;
  if (buy.symbol && STABLE_SYMBOLS.has(buy.symbol.toUpperCase()) && buy.usd != null) return buy.usd;
  return sell.usd ?? buy.usd;
}

/** Attribute stable/non-stable pairs to the non-stable traded asset. */
function tradedAssetSymbol(sell: Leg, buy: Leg): string | null {
  const sellStable = sell.symbol ? STABLE_SYMBOLS.has(sell.symbol.toUpperCase()) : false;
  const buyStable = buy.symbol ? STABLE_SYMBOLS.has(buy.symbol.toUpperCase()) : false;
  if (sellStable && !buyStable) return buy.symbol;
  if (buyStable && !sellStable) return sell.symbol;
  return sell.symbol ?? buy.symbol;
}

function addNested(
  target: Map<string, Map<string, number>>,
  outer: string,
  inner: string,
  value: number
): void {
  let map = target.get(outer);
  if (!map) {
    map = new Map();
    target.set(outer, map);
  }
  map.set(inner, (map.get(inner) ?? 0) + value);
}

function zeroes(keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function shortAddr(address: string): string {
  const s = address.toLowerCase();
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
