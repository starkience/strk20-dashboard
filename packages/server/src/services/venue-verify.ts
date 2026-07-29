/**
 * Venue verification — upgrades inferred round-trips into venue-verified
 * swaps by reading the EXTERNAL venue's own events from each transaction
 * receipt.
 *
 * Why this works and how it was validated (with the example tx link):
 * see packages/core/src/protocols/venues.ts — short version: private
 * swaps settle atomically, so the venue's `Swap` event (AVNU router) is
 * in the SAME receipt as our pool's Withdrawal + re-deposit, with
 * plaintext tokens and amounts. One `starknet_getTransactionReceipt`
 * call per candidate tx reads it.
 *
 * Loop: every tick, take the newest round-trip candidates (a tx with
 * BOTH a withdrawal and a deposit-side pool event) that haven't been
 * checked, fetch their receipts from the RPC, decode venue swaps, and
 * persist. Receipts are immutable → each tx is fetched exactly once,
 * ever; the backfill self-completes and steady state is ~a few calls per
 * sync interval. RPC errors leave no marker so the tx retries next tick.
 */

import { EVENT_SELECTORS, decodeVenueSwaps, type ReceiptEvent } from "@strk20/core";
import type { Db } from "../cache/db.js";
import { insertVenueSwaps } from "./venue-swap-store.js";

const TICK_MS = 60_000;
const BATCH_PER_TICK = 100;
const FETCH_GAP_MS = 150;
const RPC_TIMEOUT_MS = 10_000;

interface Opts {
  db: Db;
  chain: string;
  pool: string;
  rpcUrl: string;
}

export function startVenueVerify({ db, chain, pool, rpcUrl }: Opts): void {
  const candidates = db.prepare(`
    SELECT tx_hash, MIN(substr(timestamp_iso, 1, 10)) AS day
    FROM raw_events
    WHERE chain = ? AND contract = ? AND topic0 IN (?, ?, ?)
    GROUP BY tx_hash
    HAVING SUM(topic0 = ?) > 0 AND SUM(topic0 IN (?, ?)) > 0
       AND tx_hash NOT IN (SELECT tx_hash FROM tx_venue_checks WHERE chain = ?)
    ORDER BY day DESC
    LIMIT ?
  `);
  const markChecked = db.prepare(`
    INSERT OR REPLACE INTO tx_venue_checks (chain, tx_hash, checked_at, swaps_found)
    VALUES (?, ?, ?, ?)
  `);

  async function fetchReceiptEvents(txHash: string): Promise<ReceiptEvent[] | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "starknet_getTransactionReceipt",
          params: [txHash],
          id: 1,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { events?: ReceiptEvent[] } };
      return body.result?.events ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function tick(): Promise<void> {
    const rows = candidates.all(
      chain, pool,
      EVENT_SELECTORS.Deposit, EVENT_SELECTORS.OpenNoteDeposited, EVENT_SELECTORS.Withdrawal,
      EVENT_SELECTORS.Withdrawal,
      EVENT_SELECTORS.Deposit, EVENT_SELECTORS.OpenNoteDeposited,
      chain,
      BATCH_PER_TICK
    ) as { tx_hash: string; day: string }[];

    let verified = 0;
    for (const { tx_hash, day } of rows) {
      const events = await fetchReceiptEvents(tx_hash);
      if (events === null) continue; // RPC hiccup — retry next tick
      const swaps = decodeVenueSwaps(events);
      insertVenueSwaps(db, chain, tx_hash, day, swaps);
      markChecked.run(chain, tx_hash, Date.now(), swaps.length);
      if (swaps.length > 0) verified += 1;
      await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    }
    if (rows.length > 0) {
      console.log(`venue-verify: checked ${rows.length} tx, ${verified} venue-confirmed`);
    }
  }

  tick().catch((e) => console.error("venue-verify:", (e as Error).message));
  setInterval(() => {
    tick().catch((e) => console.error("venue-verify:", (e as Error).message));
  }, TICK_MS);
}
