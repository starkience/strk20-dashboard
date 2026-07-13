/**
 * Wallet classification — resolves each distinct depositor address to its
 * account CLASS HASH via `starknet_getClassHashAt`, so the wallet-families
 * aggregation can group deposits by wallet software (Ready/Argent, Braavos,
 * OpenZeppelin, …).
 *
 * Same shape as venue-verify: every tick, take depositor addresses (Deposit
 * topic1) not yet in wallet_classes, fetch their class hash from the RPC,
 * persist. A class hash only changes on an account upgrade — rare enough
 * that one fetch per address is right; the sweep self-completes and steady
 * state is only the new wallets each sync interval.
 *
 * `CONTRACT_NOT_FOUND` is a real answer, not an error: a Deposit can name a
 * counterfactual (not-yet-deployed) address. Stored as class_hash NULL so we
 * don't refetch forever; the aggregation buckets those as "undeployed".
 * Transport errors leave no marker so the address retries next tick.
 */

import { EVENT_SELECTORS } from "@strk20/core";
import type { Db } from "../cache/db.js";

const TICK_MS = 60_000;
const BATCH_PER_TICK = 250;
const FETCH_GAP_MS = 80;
const RPC_TIMEOUT_MS = 10_000;

interface Opts {
  db: Db;
  chain: string;
  pool: string;
  rpcUrl: string;
}

export function startWalletClassify({ db, chain, pool, rpcUrl }: Opts): void {
  const candidates = db.prepare(`
    SELECT DISTINCT topic1 AS addr
    FROM raw_events
    WHERE chain = ? AND contract = ? AND topic0 = ? AND topic1 IS NOT NULL
      AND topic1 NOT IN (SELECT address FROM wallet_classes WHERE chain = ?)
    LIMIT ?
  `);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO wallet_classes (chain, address, class_hash, checked_at)
    VALUES (?, ?, ?, ?)
  `);

  /** class hash | null (= not deployed) | undefined (= transport error, retry) */
  async function fetchClassHash(address: string): Promise<string | null | undefined> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "starknet_getClassHashAt",
          params: { block_id: "latest", contract_address: address },
          id: 1,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        result?: string;
        error?: { code?: number; message?: string };
      };
      if (typeof body.result === "string") return body.result;
      // 20 = CONTRACT_NOT_FOUND: a definitive "no contract here", persistable.
      if (body.error?.code === 20) return null;
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function tick(): Promise<void> {
    const rows = candidates.all(
      chain, pool, EVENT_SELECTORS.Deposit, chain, BATCH_PER_TICK
    ) as { addr: string }[];

    let resolved = 0;
    for (const { addr } of rows) {
      const classHash = await fetchClassHash(addr);
      if (classHash === undefined) continue; // RPC hiccup — retry next tick
      upsert.run(chain, addr, classHash, Date.now());
      resolved += 1;
      await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
    }
    if (rows.length > 0) {
      console.log(`wallet-classify: checked ${rows.length} addrs, ${resolved} resolved`);
    }
  }

  tick().catch((e) => console.error("wallet-classify:", (e as Error).message));
  setInterval(() => {
    tick().catch((e) => console.error("wallet-classify:", (e as Error).message));
  }, TICK_MS);
}
