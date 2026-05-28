import type { RawContractEvent } from "../starkscan/client.js";
import { SELECTOR_TO_NAME, normalizeHex, type EventName } from "./selectors.js";
import type { DecodedEvent, DecodedEventMeta } from "./types.js";

/**
 * Decode a raw Starkscan event into a typed DecodedEvent.
 *
 * Returns an `Unknown` variant for unrecognized selectors (e.g. proxy/governance
 * events from the OpenZeppelin components that aren't part of our v1 surface).
 *
 * Cairo serialization rules used here:
 *   - ContractAddress, felt252, u64: 1 felt each
 *   - u128: 1 felt (fits in felt252)
 *   - u256: 2 felts (low, high) — not used by these events
 *   - struct: concatenation of fields in declaration order
 *
 * Field ordering across keys vs data:
 *   - keys = [topic0_selector, ...#[key] fields in declaration order]
 *   - data = [...non-key fields in declaration order]
 */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  const meta: DecodedEventMeta = {
    blockNumber: raw.blockNumber,
    txHash: raw.txHash,
    txIndex: raw.txIndex,
    logIndex: raw.logIndex,
    timestampIso: raw.timestampIso,
  };

  const topic0 = normalizeHex(raw.topic0);
  const kind = SELECTOR_TO_NAME[topic0];

  if (!kind) {
    return { ...meta, kind: "Unknown", topic0 };
  }

  const keys = collectKeys(raw);
  const data = raw.data.map(normalizeHex);

  switch (kind satisfies EventName) {
    case "Deposit":
      // keys: [user_addr, token]   data: [amount]
      return {
        ...meta,
        kind: "Deposit",
        userAddr: required(keys, 0, "Deposit.user_addr"),
        token: required(keys, 1, "Deposit.token"),
        amount: toBigInt(required(data, 0, "Deposit.amount")),
      };

    case "Withdrawal":
      // keys: [to_addr, token]   data: [enc_user_addr×3, amount]
      return {
        ...meta,
        kind: "Withdrawal",
        toAddr: required(keys, 0, "Withdrawal.to_addr"),
        token: required(keys, 1, "Withdrawal.token"),
        encUserAddr: [
          required(data, 0, "Withdrawal.enc_user_addr[0]"),
          required(data, 1, "Withdrawal.enc_user_addr[1]"),
          required(data, 2, "Withdrawal.enc_user_addr[2]"),
        ] as const,
        amount: toBigInt(required(data, 3, "Withdrawal.amount")),
      };

    case "OpenNoteCreated":
      // keys: [token, note_id]   data: [enc_recipient_addr×3]
      return {
        ...meta,
        kind: "OpenNoteCreated",
        token: required(keys, 0, "OpenNoteCreated.token"),
        noteId: required(keys, 1, "OpenNoteCreated.note_id"),
        encRecipientAddr: [
          required(data, 0, "OpenNoteCreated.enc_recipient_addr[0]"),
          required(data, 1, "OpenNoteCreated.enc_recipient_addr[1]"),
          required(data, 2, "OpenNoteCreated.enc_recipient_addr[2]"),
        ] as const,
      };

    case "OpenNoteDeposited":
      // keys: [depositor, token, note_id]   data: [amount]
      return {
        ...meta,
        kind: "OpenNoteDeposited",
        depositor: required(keys, 0, "OpenNoteDeposited.depositor"),
        token: required(keys, 1, "OpenNoteDeposited.token"),
        noteId: required(keys, 2, "OpenNoteDeposited.note_id"),
        amount: toBigInt(required(data, 0, "OpenNoteDeposited.amount")),
      };

    case "EncNoteCreated":
      // keys: [note_id]   data: [packed_value]
      return {
        ...meta,
        kind: "EncNoteCreated",
        noteId: required(keys, 0, "EncNoteCreated.note_id"),
        packedValue: required(data, 0, "EncNoteCreated.packed_value"),
      };

    case "NoteUsed":
      // keys: [nullifier]   data: []
      return {
        ...meta,
        kind: "NoteUsed",
        nullifier: required(keys, 0, "NoteUsed.nullifier"),
      };

    case "ViewingKeySet":
      // keys: [user_addr, public_key]   data: [...enc_private_key (opaque)]
      return {
        ...meta,
        kind: "ViewingKeySet",
        userAddr: required(keys, 0, "ViewingKeySet.user_addr"),
        publicKey: required(keys, 1, "ViewingKeySet.public_key"),
        encPrivateKeyData: data,
      };

    case "AuditorPublicKeySet":
      // keys: []   data: [auditor_public_key]
      return {
        ...meta,
        kind: "AuditorPublicKeySet",
        auditorPublicKey: required(data, 0, "AuditorPublicKeySet.auditor_public_key"),
      };

    case "FeeAmountSet":
      // keys: []   data: [fee_amount]
      return {
        ...meta,
        kind: "FeeAmountSet",
        feeAmount: toBigInt(required(data, 0, "FeeAmountSet.fee_amount")),
      };

    case "FeeCollectorSet":
      // keys: []   data: [fee_collector]
      return {
        ...meta,
        kind: "FeeCollectorSet",
        feeCollector: required(data, 0, "FeeCollectorSet.fee_collector"),
      };

    case "ProofValidityBlocksSet":
      // keys: []   data: [proof_validity_blocks]
      return {
        ...meta,
        kind: "ProofValidityBlocksSet",
        proofValidityBlocks: toBigInt(
          required(data, 0, "ProofValidityBlocksSet.proof_validity_blocks")
        ),
      };
  }
}

function collectKeys(raw: RawContractEvent): string[] {
  // topic0 is the selector — drop it. topic1..topic3 hold up to 3 indexed fields.
  // (Starkscan flattens keys[1..] into topic1..topic3; events with >3 indexed
  // fields would overflow into data, but none of ours do.)
  return [raw.topic1, raw.topic2, raw.topic3]
    .filter((t): t is string => t != null)
    .map(normalizeHex);
}

function required<T>(arr: readonly T[], index: number, label: string): T {
  const v = arr[index];
  if (v === undefined) {
    throw new Error(`event decode: missing ${label} at index ${index}`);
  }
  return v;
}

function toBigInt(hex: string): bigint {
  return BigInt(hex);
}
