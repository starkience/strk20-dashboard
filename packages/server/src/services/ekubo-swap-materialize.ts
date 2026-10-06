import {
  EKUBO_SWAP_ANONYMIZER_ADDRESS,
  EVENT_SELECTORS,
  normalizeHex,
} from "@strk20/core";
import type { Db } from "../cache/db.js";

/**
 * Materialize the observable legs of every STRK20 → Ekubo private swap.
 *
 * The dedicated Ekubo anonymizer is an exact-input, single-hop executor:
 * the pool emits a Withdrawal to it for the input token, then an
 * OpenNoteDeposited from it for the output token in the same transaction.
 * Those pool events carry the exact token addresses and amounts, while the
 * Ekubo Core `Swapped` event decoder currently records only event presence.
 *
 * Persisting the pool legs into venue_swaps gives the dashboard a durable,
 * token-level Ekubo data source and lets the existing historical-price
 * backfill value both legs on the trade day. Existing USD values are never
 * overwritten.
 */
export function materializeEkuboPrivateSwaps(
  db: Db,
  chain: string,
  pool: string
): number {
  const rows = db
    .prepare(
      `SELECT tx_hash, substr(timestamp_iso, 1, 10) AS day, log_index,
              topic0, topic1, topic2, data_json
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?)
       ORDER BY block_number ASC, tx_index ASC, log_index ASC`
    )
    .all(
      chain,
      pool,
      EVENT_SELECTORS.Withdrawal,
      EVENT_SELECTORS.OpenNoteDeposited
    ) as {
      tx_hash: string;
      day: string;
      log_index: number;
      topic0: string;
      topic1: string | null;
      topic2: string | null;
      data_json: string;
    }[];

  const anonymizer = normalizeHex(EKUBO_SWAP_ANONYMIZER_ADDRESS);
  const withdrawal = normalizeHex(EVENT_SELECTORS.Withdrawal);
  const openDeposit = normalizeHex(EVENT_SELECTORS.OpenNoteDeposited);

  interface Leg {
    token: string;
    amount: string;
    logIndex: number;
  }
  interface TxLegs {
    day: string;
    sells: Leg[];
    buys: Leg[];
  }
  const byTx = new Map<string, TxLegs>();

  for (const row of rows) {
    if (!row.topic1 || !row.topic2 || normalizeHex(row.topic1) !== anonymizer) continue;
    const topic0 = normalizeHex(row.topic0);
    if (topic0 !== withdrawal && topic0 !== openDeposit) continue;

    let amount: string;
    try {
      const data = JSON.parse(row.data_json) as string[];
      amount = BigInt(data[topic0 === withdrawal ? 3 : 0] ?? "0x0").toString();
    } catch {
      continue;
    }
    if (amount === "0") continue;

    let tx = byTx.get(row.tx_hash);
    if (!tx) {
      tx = { day: row.day, sells: [], buys: [] };
      byTx.set(row.tx_hash, tx);
    }
    const leg = {
      token: normalizeHex(row.topic2),
      amount,
      logIndex: row.log_index,
    };
    if (topic0 === withdrawal) tx.sells.push(leg);
    else tx.buys.push(leg);
  }

  const upsert = db.prepare(`
    INSERT INTO venue_swaps
      (chain, tx_hash, evt_index, day, venue,
       sell_token, sell_amount, buy_token, buy_amount, sell_usd, buy_usd)
    VALUES (?, ?, ?, ?, 'ekubo', ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(chain, tx_hash, evt_index) DO UPDATE SET
      day = excluded.day,
      venue = 'ekubo',
      sell_token = excluded.sell_token,
      sell_amount = excluded.sell_amount,
      buy_token = COALESCE(excluded.buy_token, venue_swaps.buy_token),
      buy_amount = COALESCE(excluded.buy_amount, venue_swaps.buy_amount)
    WHERE venue_swaps.day IS NOT excluded.day
       OR venue_swaps.venue IS NOT excluded.venue
       OR venue_swaps.sell_token IS NOT excluded.sell_token
       OR venue_swaps.sell_amount IS NOT excluded.sell_amount
       OR venue_swaps.buy_token IS NOT COALESCE(excluded.buy_token, venue_swaps.buy_token)
       OR venue_swaps.buy_amount IS NOT COALESCE(excluded.buy_amount, venue_swaps.buy_amount)
  `);

  let changed = 0;
  for (const [txHash, tx] of byTx) {
    // The deployed anonymizer accepts exactly one input. Keep deterministic
    // handling for malformed/multi-input historical rows without dropping
    // volume: one venue row per observed input, paired to the corresponding
    // output when present.
    tx.sells.sort((a, b) => a.logIndex - b.logIndex);
    tx.buys.sort((a, b) => a.logIndex - b.logIndex);
    tx.sells.forEach((sell, index) => {
      const buy = tx.buys[index] ?? (tx.sells.length === 1 ? tx.buys[0] : undefined);
      const result = upsert.run(
        chain,
        txHash,
        index,
        tx.day,
        sell.token,
        sell.amount,
        buy?.token ?? null,
        buy?.amount ?? null
      );
      changed += Number(result.changes ?? 0);
    });
  }

  return changed;
}
