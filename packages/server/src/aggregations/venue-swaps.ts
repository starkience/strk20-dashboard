import type { Db } from "../cache/db.js";
import { lookupToken, applyDecimals } from "@strk20/core";

/**
 * Read side of venue verification (see services/venue-verify.ts and the
 * methodology doc in @strk20/core protocols/venues.ts).
 *
 * A tx present in this map had an actual venue swap event in its receipt
 * — it is a CONFIRMED swap, not an inferred one. `usd` is the
 * venue-reported size: the sell leg priced via the registry, falling
 * back to the buy leg (AVNU reports both, so one priced side suffices —
 * this also rescues swaps whose pool-side token has no price). Null usd
 * means the venue event was seen but neither leg is priced (or the
 * venue's ABI isn't decoded, e.g. direct Ekubo fills) — callers value
 * those from the pool's withdrawal leg.
 */
export interface VerifiedSwap {
  venue: string;
  usd: number | null;
}

export function verifiedSwapsByTx(db: Db, chain: string): Map<string, VerifiedSwap> {
  const rows = db
    .prepare(
      `SELECT tx_hash, venue, sell_token, sell_amount, buy_token, buy_amount
       FROM venue_swaps WHERE chain = ?`
    )
    .all(chain) as {
    tx_hash: string;
    venue: string;
    sell_token: string | null;
    sell_amount: string | null;
    buy_token: string | null;
    buy_amount: string | null;
  }[];

  const legUsd = (token: string | null, amount: string | null): number | null => {
    if (!token || !amount) return null;
    const meta = lookupToken(token);
    if (!meta || meta.usdApprox <= 0) return null;
    try {
      return applyDecimals(BigInt(amount), meta.decimals) * meta.usdApprox;
    } catch {
      return null;
    }
  };

  const out = new Map<string, VerifiedSwap>();
  for (const r of rows) {
    const usd = legUsd(r.sell_token, r.sell_amount) ?? legUsd(r.buy_token, r.buy_amount);
    const prev = out.get(r.tx_hash);
    if (prev) {
      // Multiple venue events in one tx (multi-route): sum priced legs.
      prev.usd = usd === null ? prev.usd : (prev.usd ?? 0) + usd;
    } else {
      out.set(r.tx_hash, { venue: r.venue, usd });
    }
  }
  return out;
}
