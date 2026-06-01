import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  protocolForAddress,
} from "@strk20/core";

/**
 * Per-token flows in a trailing window, plus center-of-chart pool stats.
 *
 * Drives the L2Beat-adapted hero chart: the outer ring is one bubble per
 * token, with two animated streams to/from the pool (deposits and withdrawals).
 * The center renders the anonymity set + window-aggregate totals.
 *
 * Privacy hygiene:
 *   - All numbers are USD totals over the window, never per-tx.
 *   - `belowPrivacyFloor` is true when a token's deposit or withdrawal count
 *     in the window falls below MIN_OPS_PER_FLOW. The client suppresses the
 *     animated stream for that side so a single tx can't leak through the
 *     animation's emission cadence.
 *   - Windows are server-whitelisted to {1h, 24h, 7d}. Arbitrary tight
 *     windows that would isolate a tx are rejected.
 */

export const FLOWS_GRAPH_WINDOWS_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

export type FlowsGraphWindow = keyof typeof FLOWS_GRAPH_WINDOWS_MS;

/** Minimum count per side for an animated stream to render. */
const MIN_OPS_PER_FLOW = 5;

export interface FlowsGraphTokenEntry {
  address: string;
  symbol: string;
  decimals: number;
  /** Current shielded balance in USD. */
  tvlUsd: number;
  /** tvlUsd / total tvlUsd, 0..1. */
  tvlShare: number;
  /** Window-USD volume of deposits. */
  depositsUsd: number;
  /** Window-USD volume of withdrawals. */
  withdrawalsUsd: number;
  /** Window count of deposit events. */
  depositCount: number;
  /** Window count of withdrawal events. */
  withdrawalCount: number;
  /** True if either side falls below the privacy floor for animation. */
  belowPrivacyFloor: boolean;
  /** True if the registry knows a USD price for this token. */
  priced: boolean;
}

export interface FlowsGraphResponse {
  windowMs: number;
  asOf: string;
  /** Center-of-chart aggregate stats. */
  center: {
    anonymitySetUnspent: number;
    tvlUsd: number;
    depositsUsd: number;
    withdrawalsUsd: number;
    depositCount: number;
    withdrawalCount: number;
    /**
     * Share (0..1) of window withdrawals broadcast by the dominant relayer
     * (currently AVNU Forwarder). Surfaces the centralized-broadcast pattern.
     */
    relayerShareWindow: number;
  };
  tokens: FlowsGraphTokenEntry[];
  /** True if any priced token couldn't be USD-valued (registry gap). */
  partial: boolean;
}

export interface FlowsGraphDeps {
  currentTvl: () => Promise<{
    totalUsd: number;
    perToken: Array<{
      address: string;
      symbol: string;
      decimals: number;
      balanceUsd: number;
      priced: boolean;
    }>;
  }>;
  anonymitySetUnspent: () => number;
}

/** Per-token sum of USD flow + event count for one event kind, in window. */
function flowByTokenInWindow(
  db: Db,
  chain: string,
  pool: string,
  topic0: string,
  amountIndex: number,
  sinceIso: string
): Map<string, { usd: number; count: number }> {
  const rows = db
    .prepare(
      `SELECT topic2 as token, data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND timestamp_iso >= ?`
    )
    .all(chain, pool, topic0, sinceIso) as { token: string; data_json: string }[];

  const out = new Map<string, { usd: number; count: number }>();
  for (const r of rows) {
    const tokenAddr = normalizeHex(r.token ?? "0x0");
    const entry = out.get(tokenAddr) ?? { usd: 0, count: 0 };
    entry.count += 1;
    const meta = lookupToken(tokenAddr);
    if (meta && meta.usdApprox > 0) {
      const data = JSON.parse(r.data_json) as string[];
      const raw = BigInt(data[amountIndex] ?? "0x0");
      entry.usd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
    }
    out.set(tokenAddr, entry);
  }
  return out;
}

/** Window share of withdrawals broadcast by any registered paymaster. */
function relayerShareInWindow(
  db: Db,
  chain: string,
  pool: string,
  sinceIso: string
): number {
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM raw_events
         WHERE chain=? AND contract=? AND topic0=? AND timestamp_iso >= ?`
      )
      .get(chain, pool, EVENT_SELECTORS.Withdrawal, sinceIso) as { n: number }
  ).n;
  if (total === 0) return 0;

  const rows = db
    .prepare(
      `SELECT topic1 as caller, COUNT(*) as n FROM raw_events
       WHERE chain=? AND contract=? AND topic0=? AND timestamp_iso >= ?
       GROUP BY topic1`
    )
    .all(chain, pool, EVENT_SELECTORS.Withdrawal, sinceIso) as {
    caller: string;
    n: number;
  }[];

  let paymasterCount = 0;
  for (const r of rows) {
    if (!r.caller) continue;
    const pid = protocolForAddress(r.caller);
    if (pid === "avnu") paymasterCount += r.n;
  }
  return paymasterCount / total;
}

export async function flowsGraph(
  db: Db,
  chain: string,
  pool: string,
  windowMs: number,
  deps: FlowsGraphDeps
): Promise<FlowsGraphResponse> {
  const now = Date.now();
  const sinceIso = new Date(now - windowMs).toISOString();

  const tvl = await deps.currentTvl();
  const totalTvlUsd = tvl.totalUsd || 0;

  const deposits = flowByTokenInWindow(
    db,
    chain,
    pool,
    EVENT_SELECTORS.Deposit,
    0,
    sinceIso
  );
  const withdrawals = flowByTokenInWindow(
    db,
    chain,
    pool,
    EVENT_SELECTORS.Withdrawal,
    3,
    sinceIso
  );

  let centerDepositsUsd = 0;
  let centerWithdrawalsUsd = 0;
  let centerDepositCount = 0;
  let centerWithdrawalCount = 0;
  let partial = false;

  const tokens: FlowsGraphTokenEntry[] = tvl.perToken.map((t) => {
    const dep = deposits.get(t.address) ?? { usd: 0, count: 0 };
    const wd = withdrawals.get(t.address) ?? { usd: 0, count: 0 };
    centerDepositsUsd += dep.usd;
    centerWithdrawalsUsd += wd.usd;
    centerDepositCount += dep.count;
    centerWithdrawalCount += wd.count;
    if (!t.priced && (dep.count > 0 || wd.count > 0)) partial = true;

    const tvlShare = totalTvlUsd > 0 ? t.balanceUsd / totalTvlUsd : 0;
    const belowPrivacyFloor =
      dep.count < MIN_OPS_PER_FLOW || wd.count < MIN_OPS_PER_FLOW;

    return {
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      tvlUsd: t.balanceUsd,
      tvlShare,
      depositsUsd: dep.usd,
      withdrawalsUsd: wd.usd,
      depositCount: dep.count,
      withdrawalCount: wd.count,
      belowPrivacyFloor,
      priced: t.priced,
    };
  });

  // Sort by deposit + withdrawal USD activity, then by TVL.
  tokens.sort((a, b) => {
    const aAct = a.depositsUsd + a.withdrawalsUsd;
    const bAct = b.depositsUsd + b.withdrawalsUsd;
    if (bAct !== aAct) return bAct - aAct;
    return b.tvlUsd - a.tvlUsd;
  });

  return {
    windowMs,
    asOf: new Date(now).toISOString(),
    center: {
      anonymitySetUnspent: deps.anonymitySetUnspent(),
      tvlUsd: totalTvlUsd,
      depositsUsd: centerDepositsUsd,
      withdrawalsUsd: centerWithdrawalsUsd,
      depositCount: centerDepositCount,
      withdrawalCount: centerWithdrawalCount,
      relayerShareWindow: relayerShareInWindow(db, chain, pool, sinceIso),
    },
    tokens,
    partial,
  };
}
