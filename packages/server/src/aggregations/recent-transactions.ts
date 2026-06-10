import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  normalizeAddress,
  protocolForAddress,
} from "@strk20/core";

/**
 * Most recent Deposit + Withdrawal events from the cached pool event stream.
 *
 * Transparency posture — represent exactly what the chain shows:
 *   - PUBLIC on-chain, so we return it: `Deposit.user_addr` (depositing is a
 *     public act; Starkscan shows it) and `Withdrawal.to_addr` (often AVNU's
 *     paymaster/forwarder executing on the real recipient's behalf — when it
 *     matches a registered protocol we attach the label so viewers know the
 *     address is infrastructure, not the end user).
 *   - PRIVATE cryptographically, so there is nothing to return: the deposit's
 *     in-pool recipient (encrypted note) and the withdrawal's funding source
 *     (`enc_user_addr`, an encrypted blob shielded by the anonymity set).
 *     The client renders those slots as shielded.
 */

export type TxKind = "Deposit" | "Withdrawal";

export interface RecentTransaction {
  txHash: string;
  blockNumber: number;
  timestampIso: string;
  kind: TxKind;
  tokenAddress: string;
  tokenSymbol: string;
  /** Human-decimaled amount string, e.g. "0.0256". */
  amount: string;
  /** USD value if the token is in the static price registry, else null. */
  amountUsd: number | null;
  /**
   * The publicly visible on-chain party:
   *   - Deposit: the depositor (`user_addr` from the event keys).
   *   - Withdrawal: the `to_addr` — frequently AVNU's paymaster/forwarder
   *     rather than the end recipient; `label` says so when attributable.
   */
  peer: {
    /** Short-form address for display. */
    addressShort: string;
    /** Protocol id from the registry, or null if unattributed. */
    protocolId: string | null;
    /** Human-readable label (e.g. "AVNU paymaster") when attributed. */
    label: string | null;
  } | null;
}

interface Row {
  tx_hash: string;
  block_number: number;
  log_index: number;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data_json: string;
  timestamp_iso: string;
}

const DEPOSIT_SEL = EVENT_SELECTORS.Deposit;
const WITHDRAWAL_SEL = EVENT_SELECTORS.Withdrawal;

export function recentTransactions(
  db: Db,
  chain: string,
  pool: string,
  limit: number,
): RecentTransaction[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT tx_hash, block_number, log_index, topic0, topic1, topic2, topic3,
              data_json, timestamp_iso
         FROM raw_events
        WHERE chain = ? AND contract = ?
          AND (topic0 = ? OR topic0 = ?)
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    )
    .all(chain, pool, DEPOSIT_SEL, WITHDRAWAL_SEL, safeLimit) as Row[];

  return rows.map((r) => decode(r));
}

function decode(r: Row): RecentTransaction {
  const isDeposit = normalizeHex(r.topic0) === DEPOSIT_SEL;
  const kind: TxKind = isDeposit ? "Deposit" : "Withdrawal";

  // Token sits in topic2 for both Deposit ([user, token]) and Withdrawal
  // ([to_addr, token]) — see the decoder for layout details.
  const tokenAddress = normalizeHex(r.topic2 ?? "0x0");
  const meta = lookupToken(tokenAddress);
  const decimals = meta?.decimals ?? 18;
  // Token sync registers every token the pool has seen, so a miss only
  // happens in the brief window before first discovery completes — show
  // the short address rather than an opaque "?".
  const symbol =
    meta?.symbol ?? `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;

  // Amount index differs by kind: Deposit.data[0], Withdrawal.data[3].
  const data = safeParseStrArray(r.data_json);
  const rawHex = data[isDeposit ? 0 : 3] ?? "0x0";
  const amountHuman = applyDecimals(BigInt(rawHex), decimals);
  const amountUsd =
    meta && meta.usdApprox > 0 ? amountHuman * meta.usdApprox : null;

  // topic1 is the public party for both kinds: Deposit.user_addr /
  // Withdrawal.to_addr (see decoder.ts event layouts).
  const peer = buildPeer(r.topic1 ?? "0x0");

  return {
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    timestampIso: r.timestamp_iso,
    kind,
    tokenAddress,
    tokenSymbol: symbol,
    amount: formatAmount(amountHuman),
    amountUsd,
    peer,
  };
}

function buildPeer(rawAddr: string) {
  const addr = normalizeAddress(rawAddr);
  const protocolId = protocolForAddress(addr);
  return {
    addressShort: shortAddr(addr),
    protocolId,
    label: protocolLabel(protocolId),
  };
}

function protocolLabel(id: string | null): string | null {
  if (id === "avnu") return "AVNU paymaster";
  if (id === "avnu-dex") return "AVNU DEX";
  if (id === "ekubo") return "Ekubo";
  if (id === "vesu") return "Vesu";
  if (id === "endur") return "Endur";
  if (id === "troves") return "Troves";
  return null;
}

function safeParseStrArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function formatAmount(n: number): string {
  if (!isFinite(n)) return "0";
  if (n === 0) return "0";
  // Two decimals max across the board, so the log stays scannable even
  // for huge meme-token amounts. Dust below 0.01 (common for BTC-likes)
  // shows as "<0.01" rather than a misleading "0.00" — the USD value in
  // parentheses carries the real magnitude.
  if (n < 0.01) return "<0.01";
  return n.toFixed(2);
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
