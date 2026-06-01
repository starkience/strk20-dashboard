import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";

export interface LifetimeVolume {
  /** USD value of all deposits since genesis (priced via the token registry). */
  depositsUsd: number;
  /** USD value of all withdrawals since genesis. */
  withdrawalsUsd: number;
  /** depositsUsd + withdrawalsUsd — gross throughput. */
  totalUsd: number;
  depositCount: number;
  withdrawalCount: number;
  /** True if any priced token was missing from the registry; numbers undercount. */
  partial: boolean;
}

/**
 * Sum the USD value of every Deposit and Withdrawal event ever cached.
 *
 * Reuses the activity-window valuation approach: priced via the static token
 * registry (no live oracle calls). Tokens not in the registry contribute zero
 * USD and flip `partial=true`. Counts include every event regardless of price.
 */
export function lifetimeVolume(db: Db, chain: string, pool: string): LifetimeVolume {
  const dep = flowAll(db, chain, pool, EVENT_SELECTORS.Deposit, 0);
  const wd = flowAll(db, chain, pool, EVENT_SELECTORS.Withdrawal, 3);
  return {
    depositsUsd: dep.usd,
    withdrawalsUsd: wd.usd,
    totalUsd: dep.usd + wd.usd,
    depositCount: dep.count,
    withdrawalCount: wd.count,
    partial: dep.partial || wd.partial,
  };
}

function flowAll(
  db: Db,
  chain: string,
  pool: string,
  topic0: string,
  amountIndex: number
): { usd: number; count: number; partial: boolean } {
  const rows = db
    .prepare(
      `SELECT topic2 as token, data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0=?`
    )
    .all(chain, pool, topic0) as { token: string; data_json: string }[];

  let usd = 0;
  let partial = false;
  for (const r of rows) {
    const meta = lookupToken(normalizeHex(r.token ?? "0x0"));
    if (!meta || meta.usdApprox === 0) {
      partial = true;
      continue;
    }
    const data = JSON.parse(r.data_json) as string[];
    const raw = BigInt(data[amountIndex] ?? "0x0");
    usd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
  }
  return { usd, count: rows.length, partial };
}
