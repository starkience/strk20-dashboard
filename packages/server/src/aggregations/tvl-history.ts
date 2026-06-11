import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
} from "@strk20/core";

/**
 * Daily TVL series reconstructed from the pool's own event stream:
 * cumulative per-token net flow (deposits − withdrawals) snapshotted at
 * each day boundary, valued at TODAY'S registry prices.
 *
 * Honest caveats, also encoded in the response:
 *   - Prices are current, not historical — the chart answers "what is
 *     the pool's historical composition worth now", which keeps the
 *     shape of accumulation visible without a historical price feed.
 *   - Unpriced tokens (vTokens…) are excluded, same as live TVL.
 *   - Protocol fees drain STRK to the collector without a Withdrawal
 *     event, so the series runs ~0.4% above the live balanceOf-based
 *     TVL by design. Counts, not custody.
 */

export interface TvlHistoryPoint {
  date: string; // YYYY-MM-DD (UTC day boundary)
  tvlUsd: number;
  /** Cumulative protocol fees collected up to this day, valued at the
   *  current STRK price (fee-paying tx count × current fee — same
   *  method as lifetime-revenue, so the two always agree). */
  feesUsd: number;
}

export interface TvlHistory {
  days: TvlHistoryPoint[];
  pricedAt: "current";
}

// STRK address on Starknet mainnet (matches the token registry entry).
const STRK_ADDR =
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** Cumulative fee-paying tx count per day (txs at/after the fee-set
 *  block, excluding the FeeAmountSet admin tx itself). */
function dailyFeeTxCounts(db: Db, chain: string, pool: string): Map<string, number> {
  const feeSet = db
    .prepare(
      `SELECT block_number, tx_hash, data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0=?
       ORDER BY block_number ASC LIMIT 1`
    )
    .get(chain, pool, EVENT_SELECTORS.FeeAmountSet) as
    | { block_number: number; tx_hash: string; data_json: string }
    | undefined;
  const out = new Map<string, number>();
  if (!feeSet) return out;
  const rows = db
    .prepare(
      `SELECT substr(MIN(timestamp_iso), 1, 10) AS day FROM raw_events
       WHERE chain=? AND contract=? AND block_number >= ? AND tx_hash != ?
       GROUP BY tx_hash`
    )
    .all(chain, pool, feeSet.block_number, feeSet.tx_hash) as { day: string }[];
  for (const r of rows) out.set(r.day, (out.get(r.day) ?? 0) + 1);
  return out;
}

/** Current fee in STRK (latest FeeAmountSet). */
function currentFeeStrk(db: Db, chain: string, pool: string): number {
  const row = db
    .prepare(
      `SELECT data_json FROM raw_events
       WHERE chain=? AND contract=? AND topic0=?
       ORDER BY block_number DESC, log_index DESC LIMIT 1`
    )
    .get(chain, pool, EVENT_SELECTORS.FeeAmountSet) as { data_json: string } | undefined;
  if (!row) return 0;
  try {
    const data = JSON.parse(row.data_json) as string[];
    return Number(applyDecimals(BigInt(data[0] ?? "0x0"), 18));
  } catch {
    return 0;
  }
}

export function tvlHistory(db: Db, chain: string, pool: string): TvlHistory {
  // Inflows are Deposit AND OpenNoteDeposited (private-swap settlement
  // funds an open note; amount at data[0] for both, token in topic2) —
  // leaving the latter out made the series run ~0.3% under live TVL.
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, topic0, topic2, data_json
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?, ?)
       ORDER BY timestamp_iso ASC`
    )
    .all(
      chain,
      pool,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.OpenNoteDeposited,
      EVENT_SELECTORS.Withdrawal
    ) as { day: string; topic0: string; topic2: string | null; data_json: string }[];

  if (rows.length === 0) return { days: [], pricedAt: "current" };

  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);
  // Running raw balance per token, mutated day by day.
  const net = new Map<string, bigint>();
  const days: TvlHistoryPoint[] = [];

  const valueNow = (): number => {
    let usd = 0;
    for (const [tok, raw] of net) {
      if (raw === 0n) continue;
      const meta = lookupToken(tok);
      if (!meta || meta.usdApprox <= 0) continue;
      usd += applyDecimals(raw, meta.decimals) * meta.usdApprox;
    }
    // Pre-launch test days can net slightly negative (the pool was
    // seeded by direct transfer, which emits no Deposit event, then
    // test-withdrawn). Sub-$15 artifact — clamp for display sanity.
    return Math.max(0, usd);
  };

  const feeTxByDay = dailyFeeTxCounts(db, chain, pool);
  const feeStrk = currentFeeStrk(db, chain, pool);
  const strkPrice = lookupToken(STRK_ADDR)?.usdApprox ?? 0;
  let cumFeeTxs = 0;
  const feesAt = (day: string): number => {
    cumFeeTxs += feeTxByDay.get(day) ?? 0;
    return cumFeeTxs * feeStrk * strkPrice;
  };

  let curDay = rows[0]!.day;
  for (const r of rows) {
    if (!r.topic2) continue;
    // Day rolled over: snapshot the balance for every day in between so
    // quiet days still get a (flat) point and the x-axis stays linear.
    while (r.day > curDay) {
      days.push({ date: curDay, tvlUsd: valueNow(), feesUsd: feesAt(curDay) });
      curDay = nextDay(curDay);
    }
    const tok = normalizeHex(r.topic2);
    let amount = 0n;
    try {
      const data = JSON.parse(r.data_json) as string[];
      const isOut = normalizeHex(r.topic0) === WD;
      amount = BigInt(data[isOut ? 3 : 0] ?? "0x0");
      net.set(tok, (net.get(tok) ?? 0n) + (isOut ? -amount : amount));
    } catch {
      /* malformed row — skip */
    }
  }
  // Snapshot the final (current, possibly partial) day, then pad up to
  // today so the chart's right edge is "now".
  const today = new Date().toISOString().slice(0, 10);
  while (curDay <= today) {
    days.push({ date: curDay, tvlUsd: valueNow(), feesUsd: feesAt(curDay) });
    curDay = nextDay(curDay);
  }

  return { days, pricedAt: "current" };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
