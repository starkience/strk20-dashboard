import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  normalizeAddress,
  protocolForAddress,
} from "@strk20/core";

/**
 * Concentration of withdrawal broadcasters.
 *
 * Privacy framing: the pool uses a paymaster pattern for withdrawals so
 * recipient addresses don't need pre-funding (a privacy property). A single
 * paymaster broadcasting ~all withdrawals knows the recipient + timing of
 * every withdrawal it handles — an off-chain correlation point. More
 * independent broadcasters → less correlation surface.
 *
 * We compute the Herfindahl-Hirschman index over withdrawal callers (the
 * standard concentration measure) plus the top broadcaster's share and the
 * distinct broadcaster count for plain-English reading.
 */

export interface RelayerConcentration {
  /** Total withdrawal events observed (lifetime). */
  totalWithdrawals: number;
  /** Number of distinct withdrawal-broadcaster addresses. */
  distinctBroadcasters: number;
  /**
   * Herfindahl-Hirschman index, 0..1. Sum of (broadcaster_share)^2.
   * 1.0 = single broadcaster monopoly. 1/N for perfectly even distribution.
   */
  hhi: number;
  /** Top broadcaster's withdrawal share, 0..1. */
  topBroadcasterShare: number;
  /** Address + protocol attribution of the dominant broadcaster. */
  topBroadcaster: {
    address: string;
    protocolId: string | null;
    withdrawalCount: number;
  } | null;
  /** Top 5 broadcasters by share, with protocol attribution. */
  topBroadcasters: Array<{
    address: string;
    protocolId: string | null;
    withdrawalCount: number;
    share: number;
  }>;
}

export function relayerConcentration(
  db: Db,
  chain: string,
  pool: string
): RelayerConcentration {
  const rows = db
    .prepare(
      `SELECT topic1 as caller, COUNT(*) as n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=?
       GROUP BY topic1
       ORDER BY n DESC`
    )
    .all(chain, pool, EVENT_SELECTORS.Withdrawal) as {
    caller: string | null;
    n: number;
  }[];

  const total = rows.reduce((acc, r) => acc + r.n, 0);
  if (total === 0) {
    return {
      totalWithdrawals: 0,
      distinctBroadcasters: 0,
      hhi: 0,
      topBroadcasterShare: 0,
      topBroadcaster: null,
      topBroadcasters: [],
    };
  }

  let hhi = 0;
  for (const r of rows) {
    const share = r.n / total;
    hhi += share * share;
  }

  const top = rows[0];
  const topBroadcaster = top?.caller
    ? {
        address: normalizeAddress(top.caller),
        protocolId: protocolForAddress(top.caller),
        withdrawalCount: top.n,
      }
    : null;

  const topBroadcasters = rows.slice(0, 5).map((r) => ({
    address: r.caller ? normalizeAddress(r.caller) : "0x0",
    protocolId: r.caller ? protocolForAddress(r.caller) : null,
    withdrawalCount: r.n,
    share: r.n / total,
  }));

  return {
    totalWithdrawals: total,
    distinctBroadcasters: rows.length,
    hhi,
    topBroadcasterShare: top ? top.n / total : 0,
    topBroadcaster,
    topBroadcasters,
  };
}
