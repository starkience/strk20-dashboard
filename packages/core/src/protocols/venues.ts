/**
 * Venue swap-event registry — decodes the EXTERNAL venue's own events out
 * of a round-trip transaction's receipt, so swap volume is measured from
 * real venue data instead of inferred from pool-event shape.
 *
 * ## How we determined AVNU swap volume is directly measurable
 *
 * The pool contract emits no swap event (it has no AMM — it delegates to
 * public DeFi through shared anonymizer contracts via `privacy_invoke`).
 * But a PRIVATE swap settles ATOMICALLY: one transaction contains the
 * pool's Withdrawal, the venue's swap, and the pool's re-deposit. The
 * venue's event is therefore present in the same receipt, emitted by the
 * venue's public contract, with plaintext tokens and amounts.
 *
 * Verified 2026-06-12 against a live round-trip tx from the pool:
 *
 *   https://voyager.online/tx/0x7c064c3c2c2fd09fb9592f1fb837bb642a0c359eb33ea2ef6c4607ac4d318b
 *
 * `starknet_getTransactionReceipt` on that hash returns 32 events from 7
 * contracts. Alongside the pool's own 6 events sit:
 *   - AVNU Exchange (0x04270219d3…) emitting `Swap`
 *     (selector 0xe316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab,
 *     = sn_keccak("Swap")), data: [taker, sell_token, sell_amount(u256 ×2),
 *     buy_token, buy_amount(u256 ×2), beneficiary] — that tx sold ~15.5 STRK.
 *   - Ekubo Core (0x…05dd3d2f…) emitting `Swapped` — AVNU routed the fill
 *     through Ekubo. Both events describe the SAME swap, so when an
 *     aggregator summary is present the underlying AMM hop must NOT be
 *     counted again (see decodeVenueSwaps).
 *
 * What this cannot see, by design: a swap split across transactions
 * (withdraw now, swap later) leaves no on-chain link — that's the pool's
 * privacy promise. Venue-verified swap volume is therefore a floor. And
 * because every private swap originates from the shared anonymizer
 * address, this stays a pool-level metric: venue-attributable, never
 * per-user.
 */

import { normalizeHex } from "../decoder/selectors.js";

/** AVNU Exchange router (swap aggregator) — also listed in PROTOCOLS. */
export const AVNU_EXCHANGE_ADDRESS =
  "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f";
/** Ekubo Core — also listed in PROTOCOLS. */
export const EKUBO_CORE_ADDRESS =
  "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b";

/** sn_keccak("Swap") — AVNU Exchange's swap-summary event. */
export const AVNU_SWAP_SELECTOR =
  "0xe316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab";
/** sn_keccak("Swapped") — Ekubo Core's per-fill event. */
export const EKUBO_SWAPPED_SELECTOR =
  "0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870";

/** One venue-emitted swap found in a transaction receipt. */
export interface VenueSwap {
  venue: "avnu" | "ekubo";
  /** Decoded legs — null when the venue's ABI isn't decoded yet (Ekubo). */
  sellToken: string | null;
  sellAmount: bigint | null;
  buyToken: string | null;
  buyAmount: bigint | null;
}

/** Minimal receipt-event shape (starknet_getTransactionReceipt `events`). */
export interface ReceiptEvent {
  from_address: string;
  keys: string[];
  data: string[];
}

function u256(lo: string | undefined, hi: string | undefined): bigint {
  return BigInt(lo ?? "0x0") + (BigInt(hi ?? "0x0") << 128n);
}

/**
 * Extract the venue swaps from one transaction's receipt events.
 *
 * Priority: AVNU `Swap` summaries win. AVNU routes fills through AMMs
 * (Ekubo hops appear in the same receipt), so counting both would double
 * the volume. Ekubo `Swapped` only counts when no aggregator summary is
 * present (a direct router.swap through the EkuboSwapAnonymizer); its
 * amounts are left null until its ABI is decoded — callers fall back to
 * the pool's withdrawal leg for value.
 */
export function decodeVenueSwaps(events: ReceiptEvent[]): VenueSwap[] {
  const avnu = normalizeHex(AVNU_EXCHANGE_ADDRESS);
  const ekubo = normalizeHex(EKUBO_CORE_ADDRESS);

  const avnuSwaps: VenueSwap[] = [];
  let ekuboFills = 0;
  for (const e of events) {
    const from = normalizeHex(e.from_address);
    const sel = e.keys[0] ? normalizeHex(e.keys[0]) : null;
    if (from === avnu && sel === normalizeHex(AVNU_SWAP_SELECTOR)) {
      // data: [taker, sell_token, sell_lo, sell_hi, buy_token, buy_lo, buy_hi, beneficiary]
      avnuSwaps.push({
        venue: "avnu",
        sellToken: e.data[1] ? normalizeHex(e.data[1]) : null,
        sellAmount: u256(e.data[2], e.data[3]),
        buyToken: e.data[4] ? normalizeHex(e.data[4]) : null,
        buyAmount: u256(e.data[5], e.data[6]),
      });
    } else if (from === ekubo && sel === normalizeHex(EKUBO_SWAPPED_SELECTOR)) {
      ekuboFills += 1;
    }
  }

  if (avnuSwaps.length > 0) return avnuSwaps;
  if (ekuboFills > 0) {
    return [{ venue: "ekubo", sellToken: null, sellAmount: null, buyToken: null, buyAmount: null }];
  }
  return [];
}
