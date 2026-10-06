import { applyDecimals, lookupToken, normalizeHex, type VenueSwap } from "@strk20/core";
import type { Db } from "../cache/db.js";

/**
 * Write side of `venue_swaps` — the single place a decoded venue swap
 * becomes a row. Extracted from venue-verify.ts so the recording rules
 * are testable without an RPC.
 *
 * Each leg's USD value is frozen HERE, at the price in force when the
 * swap was recorded, and stored alongside the raw amount. Reads must
 * never re-derive it from the live price: doing so silently rewrote
 * history every time the price feed moved.
 */
export function insertVenueSwaps(
  db: Db,
  chain: string,
  txHash: string,
  day: string,
  swaps: VenueSwap[]
): void {
  const stmt = db.prepare(`
    INSERT INTO venue_swaps
      (chain, tx_hash, evt_index, day, venue,
       sell_token, sell_amount, buy_token, buy_amount, sell_usd, buy_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain, tx_hash, evt_index) DO UPDATE SET
      day = excluded.day,
      venue = excluded.venue,
      sell_token = COALESCE(venue_swaps.sell_token, excluded.sell_token),
      sell_amount = COALESCE(venue_swaps.sell_amount, excluded.sell_amount),
      buy_token = COALESCE(venue_swaps.buy_token, excluded.buy_token),
      buy_amount = COALESCE(venue_swaps.buy_amount, excluded.buy_amount),
      sell_usd = COALESCE(venue_swaps.sell_usd, excluded.sell_usd),
      buy_usd = COALESCE(venue_swaps.buy_usd, excluded.buy_usd)
  `);
  swaps.forEach((s, i) => {
    stmt.run(
      chain, txHash, i, day, s.venue,
      s.sellToken, s.sellAmount?.toString() ?? null,
      s.buyToken, s.buyAmount?.toString() ?? null,
      priceLeg(s.sellToken, s.sellAmount),
      priceLeg(s.buyToken, s.buyAmount)
    );
  });
}

/**
 * USD value of one leg at the current price, or null when the token is
 * unknown/unpriced — an early swap can land before the Starkscan market
 * refresh has supplied its token quote. Null rows are repaired by
 * services/swap-price-backfill.ts.
 */
export function priceLeg(token: string | null, amount: bigint | string | null): number | null {
  if (!token || amount == null) return null;
  const meta = lookupToken(normalizeHex(token));
  if (!meta || meta.usdApprox <= 0) return null;
  try {
    return applyDecimals(typeof amount === "string" ? BigInt(amount) : amount, meta.decimals) *
      meta.usdApprox;
  } catch {
    return null;
  }
}
