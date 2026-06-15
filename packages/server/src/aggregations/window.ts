import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";
import { countByTopicSinceIso } from "./_helpers.js";
import { verifiedSwapsByTx } from "./venue-swaps.js";

export interface WindowStats {
  deposits: number;
  withdrawals: number;
  /** Net USD flow (deposits − withdrawals) over the window, priced via the
   *  registry majors — an activity-based proxy for TVL change. */
  tvlChangeUsd: number;
}

/** Activity in a trailing window (default caller passes 24h). */
export function windowStats(
  db: Db,
  chain: string,
  pool: string,
  sinceMs: number
): WindowStats {
  const sinceIso = new Date(sinceMs).toISOString();
  const deposits = countByTopicSinceIso(db, chain, pool, EVENT_SELECTORS.Deposit, sinceIso);
  const withdrawals = countByTopicSinceIso(db, chain, pool, EVENT_SELECTORS.Withdrawal, sinceIso);

  let net = 0;
  net += flowUsd(db, chain, pool, EVENT_SELECTORS.Deposit, sinceIso, 0);
  // Open-note funding (swap returns etc.) is an inflow too.
  net += flowUsd(db, chain, pool, EVENT_SELECTORS.OpenNoteDeposited, sinceIso, 0);
  net -= flowUsd(db, chain, pool, EVENT_SELECTORS.Withdrawal, sinceIso, 3);

  return { deposits, withdrawals, tvlChangeUsd: net };
}


export interface WindowConversions {
  /** Cross-token round-trips that are genuine trades. */
  swaps: number;
  /** Round-trips into/out of liquid-staking receipts (xSTRK, xstrkBTC…). */
  stakes: number;
  /** Round-trips into/out of lending receipts (vUSDC, vETH, pUSDC…). */
  lends: number;
}

/**
 * In-pool conversions in a trailing window. The observable footprint of
 * a private swap is one transaction containing BOTH a Withdrawal of
 * token A and a Deposit of token B (out to the venue, back into the
 * pool as something else). A round-trip counts as a SWAP only when the
 * venue's own swap event is present in its receipt (venue-verified —
 * see services/venue-verify.ts and core protocols/venues.ts for the
 * methodology and a worked example tx). Round-trips where the
 * destination token is a staked/wrapped derivative of the source
 * (strkBTC→xstrkBTC, STRK→xSTRK, USDC→vUSDC — prefix convention x/v/p,
 * both directions) are counted as staking/lending by symbol convention.
 *
 * This is a floor, not a census: a swap deliberately split across two
 * transactions, or a same-token round-trip, leaves no countable
 * signature — by design of the privacy pool.
 */
export function windowConversions(
  db: Db,
  chain: string,
  pool: string,
  sinceMs: number
): WindowConversions {
  const sinceIso = new Date(sinceMs).toISOString();
  // Inflow side is Deposit OR OpenNoteDeposited: private swaps settle
  // their output into the pool through deposit_to_open_note (the AVNU
  // executor funds an open note for the user), which emits
  // OpenNoteDeposited — token in topic2, same as Deposit.
  const rows = db
    .prepare(
      `SELECT tx_hash, topic0, topic2 FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?, ?) AND timestamp_iso >= ?`
    )
    .all(
      chain, pool,
      EVENT_SELECTORS.Deposit, EVENT_SELECTORS.OpenNoteDeposited,
      EVENT_SELECTORS.Withdrawal, sinceIso
    ) as { tx_hash: string; topic0: string; topic2: string | null }[];

  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);
  const byTx = new Map<string, { outs: Set<string>; ins: Set<string> }>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) { e = { outs: new Set(), ins: new Set() }; byTx.set(r.tx_hash, e); }
    const tok = normalizeHex(r.topic2);
    if (normalizeHex(r.topic0) === WD) e.outs.add(tok);
    else e.ins.add(tok);
  }

  // Swaps require venue verification (the venue's own swap event in the
  // tx receipt — see services/venue-verify.ts); stake/lend keep the
  // wrapper-symbol classification below.
  const verified = verifiedSwapsByTx(db, chain);
  let swaps = 0;
  let stakes = 0;
  let lends = 0;
  for (const [txHash, { outs, ins }] of byTx) {
    // Wrap conventions outrank the venue event: a wrap routed via AVNU
    // emits a Swap event too, but the user's intent is staking/lending.
    const kind = classifyRoundTrip(outs, ins);
    if (kind === "stake") stakes += 1;
    else if (kind === "lend") lends += 1;
    else if (verified.has(txHash)) swaps += 1;
  }
  return { swaps, stakes, lends };
}

/**
 * Wrapper conventions: x-prefix = liquid staking (xSTRK, xstrkBTC,
 * xWBTC → Endur), v/p-prefix = lending supply receipts (vUSDC, vETH →
 * Vesu; pUSDC). Checked both directions so unwinds count in the same
 * bucket as entries.
 */
export function wrapKind(a: string, b: string): "stake" | "lend" | null {
  const sa = lookupToken(a)?.symbol;
  const sb = lookupToken(b)?.symbol;
  if (!sa || !sb) return null;
  if (sb === "x" + sa || sa === "x" + sb) return "stake";
  if (sb === "v" + sa || sa === "v" + sb) return "lend";
  if (sb === "p" + sa || sa === "p" + sb) return "lend";
  return null;
}

/**
 * Classify one round-trip tx by its cross-token pairs (tokens that came
 * in but didn't go out, and vice versa — same-token change notes are
 * ignored). All pairs wrapping into staking receipts → stake; into
 * lending receipts → lend; anything else cross-token → swap.
 */
export function classifyRoundTrip(
  outs: Set<string>,
  ins: Set<string>
): "swap" | "stake" | "lend" | null {
  if (outs.size === 0 || ins.size === 0) return null;
  // Tokens that newly appeared / fully disappeared. A token on both
  // sides is change (partial spend) and classifies nothing by itself —
  // but it still counts as a wrap-source/destination for the tokens
  // that did cross (out USDC → in STRK + leftover USDC is a swap).
  const crossIns = [...ins].filter((t) => !outs.has(t));
  const crossOuts = [...outs].filter((t) => !ins.has(t));
  if (crossIns.length === 0 && crossOuts.length === 0) return null;
  // Stake/lend only when the wrap explains EVERY crossing leg in BOTH
  // directions. A tx that withdrew xSTRK + WBTC and received only
  // xWBTC staked the WBTC — but the xSTRK leg was converted, so the
  // transaction as a whole is a swap. Any unexplained leg → swap.
  const kinds: ("stake" | "lend")[] = [];
  const usedOuts = new Set<string>();
  for (const i of crossIns) {
    let matched: "stake" | "lend" | null = null;
    for (const o of outs) {
      const w = wrapKind(o, i);
      if (w) { matched = w; usedOuts.add(o); break; }
    }
    if (!matched) return "swap";
    kinds.push(matched);
  }
  for (const o of crossOuts) {
    if (!usedOuts.has(o)) {
      // An out-leg no wrap accounts for. With no wrapped ins at all
      // this is the unwrap direction — check it against the ins.
      let matched: "stake" | "lend" | null = null;
      for (const i of ins) {
        const w = wrapKind(o, i);
        if (w) { matched = w; break; }
      }
      if (!matched) return "swap";
      kinds.push(matched);
    }
  }
  if (kinds.length === 0) return "swap";
  if (kinds.every((k) => k === "stake")) return "stake";
  if (kinds.every((k) => k === "lend")) return "lend";
  return "swap";
}

/** Sum USD value of an event type's amounts since a cutoff. `amountIndex` is
 *  the position of `amount` in the event's data array (Deposit=0, Withdrawal=3). */
function flowUsd(
  db: Db,
  chain: string,
  pool: string,
  topic0: string,
  sinceIso: string,
  amountIndex: number
): number {
  const rows = db
    .prepare(
      `SELECT topic2 as token, data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND timestamp_iso >= ?`
    )
    .all(chain, pool, topic0, sinceIso) as { token: string; data_json: string }[];

  let usd = 0;
  for (const r of rows) {
    const meta = lookupToken(normalizeHex(r.token ?? "0x0"));
    if (!meta || meta.usdApprox === 0) continue;
    const data = JSON.parse(r.data_json) as string[];
    const raw = BigInt(data[amountIndex] ?? "0x0");
    usd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
  }
  return usd;
}
