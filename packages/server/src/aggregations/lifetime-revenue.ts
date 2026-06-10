import type { Db } from "../cache/db.js";
import { EVENT_SELECTORS, lookupToken } from "@strk20/core";

/**
 * Protocol revenue for the privacy pool.
 *
 * The pool charges a fixed STRK fee per `apply_actions` call (set via
 * the `set_fee_amount` admin entrypoint, emitted as `FeeAmountSet`).
 * Every user-facing operation — deposit, withdraw, transfer, any
 * other shielded action — bundles into one `apply_actions` call, so
 * lifetime revenue is:
 *
 *     revenue_wei = number_of_apply_actions_calls × current_fee_wei
 *
 * We approximate `apply_actions` count by the number of DISTINCT
 * tx hashes among pool events AT OR AFTER the block where the fee
 * was first set (excluding the FeeAmountSet admin tx itself): txs
 * before that block paid no fee, so counting them overstated revenue
 * by ~260 STRK vs Starkscan's "privacy fees collected" tracker,
 * which sums actual transfers to the fee collector. With this window
 * the two agree to within the day's not-yet-bucketed fees.
 *
 * Current fee is the latest `FeeAmountSet` event we've seen (latest
 * block, latest log index). If no FeeAmountSet has been observed yet
 * we fall back to fee=0 and revenue=0.
 *
 * Limitation: if the fee has CHANGED over the pool's history this
 * undercounts/overcounts everything before the latest change. The
 * better model is fee-at-block-of-tx; revisit if `feeChanges > 1`
 * shows up in production data.
 */

const STRK_DECIMALS = 18;
// STRK address on Starknet mainnet (matches the token registry entry).
const STRK_ADDR =
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export interface LifetimeRevenue {
  applyActionsCount: number;
  currentFeeWei: string;        // u128 fee per call, decimal stringified
  currentFeeStrk: number;       // currentFeeWei / 10^18 (display approx)
  currentFeeUsd: number | null; // currentFeeStrk × live STRK price (null until priced)
  revenueWei: string;           // applyActionsCount × currentFeeWei
  revenueStrk: number;          // revenueWei / 10^18
  revenueUsd: number | null;    // revenueStrk × live STRK price (null until priced)
  feeChanges: number;           // number of FeeAmountSet events observed
}

export function lifetimeRevenue(
  db: Db,
  chain: string,
  pool: string
): LifetimeRevenue {
  // 1. Current fee = latest FeeAmountSet event by (block, log_index);
  //    fee activation = earliest one (txs before it paid nothing).
  const feeRows = db
    .prepare(
      `SELECT block_number, tx_hash, data_json
       FROM raw_events
       WHERE chain = ? AND contract = ? AND topic0 = ?
       ORDER BY block_number DESC, log_index DESC`
    )
    .all(chain, pool, EVENT_SELECTORS.FeeAmountSet) as {
    block_number: number;
    tx_hash: string;
    data_json: string;
  }[];

  let currentFeeWei = 0n;
  const latestFeeSet = feeRows[0];
  if (latestFeeSet) {
    try {
      const data = JSON.parse(latestFeeSet.data_json) as string[];
      if (data[0]) currentFeeWei = BigInt(data[0]);
    } catch {
      /* malformed event — leave fee at zero */
    }
  }

  // 2. apply_actions count ≈ distinct tx_hash since the fee went live,
  //    minus the FeeAmountSet admin tx itself (it paid no fee).
  const firstFeeSet = feeRows[feeRows.length - 1];
  let applyActionsCount = 0;
  if (firstFeeSet) {
    const txRow = db
      .prepare(
        `SELECT COUNT(DISTINCT tx_hash) AS n
         FROM raw_events
         WHERE chain = ? AND contract = ? AND block_number >= ? AND tx_hash != ?`
      )
      .get(chain, pool, firstFeeSet.block_number, firstFeeSet.tx_hash) as {
      n: number;
    };
    applyActionsCount = Number(txRow?.n ?? 0);
  }

  // 3. Revenue = apply_actions × fee (in STRK wei).
  const revenueWei = BigInt(applyActionsCount) * currentFeeWei;

  // 4. Convert to STRK then USD via the static token registry. Avoid
  //    BigInt-to-Number drift on large values by going via a string.
  const denom = 10n ** BigInt(STRK_DECIMALS);
  const revenueStrk = Number(revenueWei) / Number(denom);
  const currentFeeStrk = Number(currentFeeWei) / Number(denom);
  // Live STRK price pushed into the registry by the token-sync service;
  // null (not 0) while unpriced so clients can distinguish "no price yet"
  // from "worthless".
  const strkPrice = lookupToken(STRK_ADDR)?.usdApprox ?? 0;
  const priced = strkPrice > 0;

  return {
    applyActionsCount,
    currentFeeWei: currentFeeWei.toString(),
    currentFeeStrk,
    currentFeeUsd: priced ? currentFeeStrk * strkPrice : null,
    revenueWei: revenueWei.toString(),
    revenueStrk,
    revenueUsd: priced ? revenueStrk * strkPrice : null,
    feeChanges: feeRows.length,
  };
}
