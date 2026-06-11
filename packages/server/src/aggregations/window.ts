import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";
import { countByTopicSinceIso } from "./_helpers.js";

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
  net -= flowUsd(db, chain, pool, EVENT_SELECTORS.Withdrawal, sinceIso, 3);

  return { deposits, withdrawals, tvlChangeUsd: net };
}


export interface WindowConversions {
  /** Cross-token round-trips that are genuine trades. */
  swaps: number;
  /** Cross-token round-trips into/out of a staked wrapper (xSTRK, vUSDC…). */
  stakes: number;
}

/**
 * In-pool conversions in a trailing window. The observable footprint of
 * a private swap is one transaction containing BOTH a Withdrawal of
 * token A and a Deposit of token B (out to the venue, back into the
 * pool as something else). Round-trips where the destination token is
 * a staked/wrapped derivative of the source (strkBTC→xstrkBTC,
 * STRK→xSTRK, USDC→vUSDC — prefix convention x/v/p, both directions)
 * are counted as staking instead of swaps.
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
  const rows = db
    .prepare(
      `SELECT tx_hash, topic0, topic2 FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?) AND timestamp_iso >= ?`
    )
    .all(
      chain, pool,
      EVENT_SELECTORS.Deposit, EVENT_SELECTORS.Withdrawal, sinceIso
    ) as { tx_hash: string; topic0: string; topic2: string | null }[];

  const DEP = normalizeHex(EVENT_SELECTORS.Deposit);
  const byTx = new Map<string, { outs: Set<string>; ins: Set<string> }>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) { e = { outs: new Set(), ins: new Set() }; byTx.set(r.tx_hash, e); }
    const tok = normalizeHex(r.topic2);
    if (normalizeHex(r.topic0) === DEP) e.ins.add(tok);
    else e.outs.add(tok);
  }

  const WRAP_PREFIXES = ["x", "v", "p"];
  const isWrapPair = (a: string, b: string): boolean => {
    const sa = lookupToken(a)?.symbol;
    const sb = lookupToken(b)?.symbol;
    if (!sa || !sb) return false;
    return WRAP_PREFIXES.some((p) => sb === p + sa || sa === p + sb);
  };

  let swaps = 0;
  let stakes = 0;
  for (const { outs, ins } of byTx.values()) {
    if (outs.size === 0 || ins.size === 0) continue;
    // Cross pairs: tokens that came in but did not go out (and vice
    // versa) — ignores same-token change notes.
    const crossIns = [...ins].filter((t) => !outs.has(t));
    const crossOuts = [...outs].filter((t) => !ins.has(t));
    if (crossIns.length === 0 || crossOuts.length === 0) continue;
    const allWrap = crossIns.every((i) => crossOuts.some((o) => isWrapPair(o, i)));
    if (allWrap) stakes += 1;
    else swaps += 1;
  }
  return { swaps, stakes };
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
