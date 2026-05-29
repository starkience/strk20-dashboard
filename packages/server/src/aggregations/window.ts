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
