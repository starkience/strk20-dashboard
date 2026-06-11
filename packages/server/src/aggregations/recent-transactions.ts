import type { Db } from "../cache/db.js";
import {
  EVENT_SELECTORS,
  lookupToken,
  applyDecimals,
  normalizeHex,
  normalizeAddress,
  protocolForAddress,
} from "@strk20/core";
import { classifyRoundTrip, wrapKind } from "./window.js";

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

export type TxKind = "Deposit" | "Withdrawal" | "Swap" | "Stake" | "Lend";

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
  /**
   * For conversion kinds (Swap/Stake/Lend) only: the leg that came BACK
   * into the pool. The top-level token/amount fields describe the out
   * leg, so a swap renders "3000 STRK → 102.56 USDC".
   */
  inLeg?: {
    tokenAddress: string;
    tokenSymbol: string;
    amount: string;
    amountUsd: number | null;
  };
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
const OPEN_NOTE_SEL = EVENT_SELECTORS.OpenNoteDeposited;

export function recentTransactions(
  db: Db,
  chain: string,
  pool: string,
  limit: number,
): RecentTransaction[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  // Over-fetch (each conversion collapses several events into one
  // entry) then group by transaction so private swaps render as ONE
  // "Swap" item with both legs, not as a bare withdrawal. The return
  // leg of a swap arrives via OpenNoteDeposited, not Deposit.
  const rows = db
    .prepare(
      `SELECT tx_hash, block_number, log_index, topic0, topic1, topic2, topic3,
              data_json, timestamp_iso
         FROM raw_events
        WHERE chain = ? AND contract = ?
          AND topic0 IN (?, ?, ?)
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    )
    .all(chain, pool, DEPOSIT_SEL, WITHDRAWAL_SEL, OPEN_NOTE_SEL, safeLimit * 4) as Row[];

  // Group rows per tx, preserving recency order of first appearance.
  const order: string[] = [];
  const byTx = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byTx.has(r.tx_hash)) {
      byTx.set(r.tx_hash, []);
      order.push(r.tx_hash);
    }
    byTx.get(r.tx_hash)!.push(r);
  }

  const out: RecentTransaction[] = [];
  for (const hash of order) {
    if (out.length >= safeLimit) break;
    const txRows = byTx.get(hash)!;
    const wds = txRows.filter((r) => normalizeHex(r.topic0) === normalizeHex(WITHDRAWAL_SEL));
    const ins = txRows.filter((r) => normalizeHex(r.topic0) !== normalizeHex(WITHDRAWAL_SEL));
    const outTokens = new Set(wds.map((r) => normalizeHex(r.topic2 ?? "0x0")));
    const inTokens = new Set(ins.map((r) => normalizeHex(r.topic2 ?? "0x0")));
    const kind = classifyRoundTrip(outTokens, inTokens);
    if (kind) {
      out.push(conversionEntry(kind, txRows, wds, ins, outTokens, inTokens));
    } else {
      for (const r of txRows) {
        if (out.length >= safeLimit) break;
        out.push(decode(r));
      }
    }
  }
  return out;
}

/** Sum a leg's rows for one token into display fields. */
function legFields(rowsForToken: Row[], token: string, amountIndex: (r: Row) => number) {
  const meta = lookupToken(token);
  const decimals = meta?.decimals ?? 18;
  const symbol = meta?.symbol ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
  let raw = 0n;
  for (const r of rowsForToken) {
    try {
      const data = JSON.parse(r.data_json) as string[];
      raw += BigInt(data[amountIndex(r)] ?? "0x0");
    } catch { /* skip malformed row */ }
  }
  const human = applyDecimals(raw, decimals);
  return {
    tokenAddress: token,
    tokenSymbol: symbol,
    amount: formatAmount(human),
    amountUsd: meta && meta.usdApprox > 0 ? human * meta.usdApprox : null,
  };
}

function conversionEntry(
  kind: "swap" | "stake" | "lend",
  txRows: Row[],
  wds: Row[],
  ins: Row[],
  outTokens: Set<string>,
  inTokens: Set<string>,
): RecentTransaction {
  // Display tokens: prefer the ones that actually crossed (ignore
  // same-token change notes), fall back to whatever is there.
  let crossOut = [...outTokens].find((t) => !inTokens.has(t)) ?? [...outTokens][0]!;
  let crossIn = [...inTokens].find((t) => !outTokens.has(t)) ?? [...inTokens][0]!;
  // For stake/lend entries show the pair that actually wrapped: a
  // multi-leg tx that withdrew xSTRK + WBTC and staked into xWBTC
  // should read "WBTC -> xWBTC", not "xSTRK -> xWBTC".
  if (kind !== "swap") {
    outer: for (const i of inTokens) {
      if (outTokens.has(i)) continue;
      for (const o of outTokens) {
        if (wrapKind(o, i)) {
          crossOut = o;
          crossIn = i;
          break outer;
        }
      }
    }
  }
  const outLeg = legFields(
    wds.filter((r) => normalizeHex(r.topic2 ?? "0x0") === crossOut),
    crossOut,
    () => 3, // Withdrawal amount at data[3]
  );
  const inLeg = legFields(
    ins.filter((r) => normalizeHex(r.topic2 ?? "0x0") === crossIn),
    crossIn,
    () => 0, // Deposit + OpenNoteDeposited amounts at data[0]
  );
  const first = txRows[0]!;
  const firstWd = wds[0];
  return {
    txHash: first.tx_hash,
    blockNumber: first.block_number,
    timestampIso: first.timestamp_iso,
    kind: kind === "swap" ? "Swap" : kind === "stake" ? "Stake" : "Lend",
    ...outLeg,
    peer: firstWd ? buildPeer(firstWd.topic1 ?? "0x0") : null,
    inLeg,
  };
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
