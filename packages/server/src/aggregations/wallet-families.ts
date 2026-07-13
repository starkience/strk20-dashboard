import type { Db } from "../cache/db.js";
import { EVENT_SELECTORS } from "@strk20/core";

/**
 * Activity by wallet family — which wallet software the pool's depositors
 * run, weighted by Deposit events. Public deposit addresses only (topic1 of
 * Deposit): withdrawals go to fresh addresses and in-pool spends carry no
 * owner, so this is the only side the chain exposes — same basis as
 * Starkscan's "activity by wallet" view.
 *
 * Wallets are grouped by their account CLASS HASH (resolved by the
 * wallet-classify service into wallet_classes). The class-hash → family map
 * below is curated: hashes were verified empirically against this pool's own
 * depositor set (grouped, then cross-checked against the wallets' published
 * class hashes). Unknown hashes fold into "other"; the raw hash list per
 * family is returned so new prominent hashes can be identified and added.
 */

// Verified account class hashes → wallet family. Display names, not ids —
// the frontend shows these as-is. Verification (2026-07-13): labels from
// Starkscan's official_class_registry where present; the Xverse hash is an
// unregistered Argent-preset build whose ABI carries Secp256k1 (Bitcoin-key)
// signers — the account contract Xverse deploys for its Starknet users — and
// whose deposit-event share matches Starkscan's own "Xverse" bucket (~17%).
const CLASS_FAMILIES: Record<string, string> = {
  // Ready (ex-Argent) v0.4.0 — registry label "Argent Account".
  "0x36078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f": "Ready / Argent",
  // Argent preset with Secp256k1 signer support (Bitcoin-key accounts).
  "0x663fc01a0dbe1bacc4cd2a4c856eb9784b255a20988aa33d4d52b6fc20bd024": "Xverse",
  // Pre-0.4 Argent versions — registry-labeled, kept as their own row so the
  // upgrade lag is visible (mirrors Starkscan's "Argent older" split).
  "0x73414441639dcd11d1846f287650a00c60c416b9d3ba45d31c651672125b2c2": "Argent (older)",
  "0x29927c8af6bccf3f6fda035981e765a7bdbf18a2dc0d630494f8758aa908e2b": "Argent (older)",
  "0x1a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003": "Argent (older)",
};

export interface WalletFamily {
  family: string;
  wallets: number; // distinct depositor addresses on this family
  events: number; // Deposit events from those wallets
  share: number; // events / totalEvents, 0..1
  classHashes: string[]; // hashes folded into this family (ops/curation aid)
}

export interface WalletFamilies {
  families: WalletFamily[]; // sorted by events desc
  totalWallets: number; // all distinct depositor addresses
  totalEvents: number; // all Deposit events
  classifiedWallets: number; // wallets with a resolved wallet_classes row
  pendingWallets: number; // not yet swept by wallet-classify
}

export function walletFamilies(db: Db, chain: string, pool: string): WalletFamilies {
  const rows = db
    .prepare(
      `SELECT e.topic1 AS addr, COUNT(*) AS events, w.class_hash AS classHash,
              (w.address IS NOT NULL) AS checked
       FROM raw_events e
       LEFT JOIN wallet_classes w ON w.chain = e.chain AND w.address = e.topic1
       WHERE e.chain=? AND e.contract=? AND e.topic0=? AND e.topic1 IS NOT NULL
       GROUP BY e.topic1`
    )
    .all(chain, pool, EVENT_SELECTORS.Deposit) as {
    addr: string;
    events: number;
    classHash: string | null;
    checked: number;
  }[];

  interface Acc { wallets: number; events: number; hashes: Set<string> }
  const byFamily = new Map<string, Acc>();
  let totalWallets = 0;
  let totalEvents = 0;
  let classified = 0;

  for (const r of rows) {
    totalWallets += 1;
    totalEvents += Number(r.events);
    let family: string;
    if (!r.checked) {
      family = "pending"; // classify sweep hasn't reached it yet
    } else if (r.classHash == null) {
      classified += 1;
      family = "undeployed"; // counterfactual deposit address, no contract
    } else {
      classified += 1;
      family = CLASS_FAMILIES[r.classHash] ?? "other";
    }
    let acc = byFamily.get(family);
    if (!acc) { acc = { wallets: 0, events: 0, hashes: new Set() }; byFamily.set(family, acc); }
    acc.wallets += 1;
    acc.events += Number(r.events);
    if (r.classHash) acc.hashes.add(r.classHash);
  }

  const families: WalletFamily[] = [...byFamily.entries()]
    .map(([family, a]) => ({
      family,
      wallets: a.wallets,
      events: a.events,
      share: totalEvents > 0 ? a.events / totalEvents : 0,
      classHashes: [...a.hashes].sort(),
    }))
    .sort((x, y) => y.events - x.events);

  return {
    families,
    totalWallets,
    totalEvents,
    classifiedWallets: classified,
    pendingWallets: totalWallets - classified,
  };
}
