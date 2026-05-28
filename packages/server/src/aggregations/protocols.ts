import type Database from "better-sqlite3";
import {
  EVENT_SELECTORS,
  PROTOCOLS,
  protocolForAddress,
  normalizeAddress,
} from "@strk20/core";

const HOUR_MS = 60 * 60 * 1000;

export interface ProtocolActivity {
  id: string;
  label: string;
  depositCount: number;
  withdrawalCount: number;
  totalCount: number;
  lastSeenIso: string | null;
  recentlyActive: boolean;
  needsCuration: boolean;
}

/**
 * For each protocol in the address book, count how many Deposit/Withdrawal
 * events were routed through one of its registered addresses.
 *
 * For Deposits  → topic1 is `user_addr`  (caller)
 * For Withdrawals → topic1 is `to_addr` (destination, often a router)
 */
export function activeProtocols(
  db: Database.Database,
  chain: string,
  contract: string
): ProtocolActivity[] {
  const now = Date.now();
  return PROTOCOLS.map((p) => {
    if (p.addresses.length === 0) {
      return {
        id: p.id,
        label: p.label,
        depositCount: 0,
        withdrawalCount: 0,
        totalCount: 0,
        lastSeenIso: null,
        recentlyActive: false,
        needsCuration: p.needsCuration,
      };
    }
    const placeholders = p.addresses.map(() => "?").join(",");
    const params = [chain, contract, ...p.addresses.map(normalizeAddress)];

    const depRow = db
      .prepare(
        `SELECT COUNT(*) as n, MAX(timestamp_iso) as last_iso
         FROM raw_events
         WHERE chain=? AND contract=? AND topic0='${EVENT_SELECTORS.Deposit}'
           AND topic1 IN (${placeholders})`
      )
      .get(...params) as { n: number; last_iso: string | null };

    const wRow = db
      .prepare(
        `SELECT COUNT(*) as n, MAX(timestamp_iso) as last_iso
         FROM raw_events
         WHERE chain=? AND contract=? AND topic0='${EVENT_SELECTORS.Withdrawal}'
           AND topic1 IN (${placeholders})`
      )
      .get(...params) as { n: number; last_iso: string | null };

    const depositCount = depRow?.n ?? 0;
    const withdrawalCount = wRow?.n ?? 0;
    const lastIso = mostRecent(depRow?.last_iso, wRow?.last_iso);
    const recentlyActive =
      lastIso != null && now - new Date(lastIso).getTime() < HOUR_MS;

    return {
      id: p.id,
      label: p.label,
      depositCount,
      withdrawalCount,
      totalCount: depositCount + withdrawalCount,
      lastSeenIso: lastIso,
      recentlyActive,
      needsCuration: p.needsCuration,
    };
  });
}

export interface TopCaller {
  address: string;
  depositCount: number;
  withdrawalCount: number;
  totalCount: number;
  protocolId: string | null;
}

/**
 * Empirical discovery: list the top distinct addresses that appear in
 * Deposit.user_addr / Withdrawal.to_addr. Use this to identify which
 * addresses to add to PROTOCOLS in the data-client address book.
 */
export function topCallers(
  db: Database.Database,
  chain: string,
  contract: string,
  limit = 25
): TopCaller[] {
  const stmt = db.prepare(`
    SELECT
      topic1 as address,
      SUM(CASE WHEN topic0 = ? THEN 1 ELSE 0 END) as deposit_count,
      SUM(CASE WHEN topic0 = ? THEN 1 ELSE 0 END) as withdrawal_count,
      COUNT(*) as total_count
    FROM raw_events
    WHERE chain = ? AND contract = ?
      AND (topic0 = ? OR topic0 = ?)
      AND topic1 IS NOT NULL
    GROUP BY topic1
    ORDER BY total_count DESC
    LIMIT ?
  `);
  const rows = stmt.all(
    EVENT_SELECTORS.Deposit,
    EVENT_SELECTORS.Withdrawal,
    chain,
    contract,
    EVENT_SELECTORS.Deposit,
    EVENT_SELECTORS.Withdrawal,
    limit
  ) as {
    address: string;
    deposit_count: number;
    withdrawal_count: number;
    total_count: number;
  }[];

  return rows.map((r) => ({
    address: normalizeAddress(r.address),
    depositCount: r.deposit_count,
    withdrawalCount: r.withdrawal_count,
    totalCount: r.total_count,
    protocolId: protocolForAddress(r.address),
  }));
}

function mostRecent(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return a > b ? a : b;
}
