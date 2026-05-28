/** Common metadata on every decoded event — copied from RawContractEvent. */
export interface DecodedEventMeta {
  blockNumber: number;
  txHash: string;
  txIndex: number;
  logIndex: number;
  timestampIso: string;
}

export type DepositEvent = DecodedEventMeta & {
  kind: "Deposit";
  userAddr: string;
  token: string;
  amount: bigint;
};

export type WithdrawalEvent = DecodedEventMeta & {
  kind: "Withdrawal";
  toAddr: string;
  token: string;
  amount: bigint;
  /** Encrypted source address — auditor-decryptable, opaque to the dashboard. */
  encUserAddr: readonly [string, string, string];
};

export type OpenNoteCreatedEvent = DecodedEventMeta & {
  kind: "OpenNoteCreated";
  token: string;
  noteId: string;
  encRecipientAddr: readonly [string, string, string];
};

export type OpenNoteDepositedEvent = DecodedEventMeta & {
  kind: "OpenNoteDeposited";
  depositor: string;
  token: string;
  noteId: string;
  amount: bigint;
};

export type EncNoteCreatedEvent = DecodedEventMeta & {
  kind: "EncNoteCreated";
  noteId: string;
  packedValue: string;
};

export type NoteUsedEvent = DecodedEventMeta & {
  kind: "NoteUsed";
  nullifier: string;
};

export type ViewingKeySetEvent = DecodedEventMeta & {
  kind: "ViewingKeySet";
  userAddr: string;
  publicKey: string;
  /** Encrypted private key payload — opaque to the dashboard. */
  encPrivateKeyData: readonly string[];
};

export type AuditorPublicKeySetEvent = DecodedEventMeta & {
  kind: "AuditorPublicKeySet";
  auditorPublicKey: string;
};

export type FeeAmountSetEvent = DecodedEventMeta & {
  kind: "FeeAmountSet";
  feeAmount: bigint;
};

export type FeeCollectorSetEvent = DecodedEventMeta & {
  kind: "FeeCollectorSet";
  feeCollector: string;
};

export type ProofValidityBlocksSetEvent = DecodedEventMeta & {
  kind: "ProofValidityBlocksSet";
  proofValidityBlocks: bigint;
};

export type UnknownEvent = DecodedEventMeta & {
  kind: "Unknown";
  topic0: string;
};

export type DecodedEvent =
  | DepositEvent
  | WithdrawalEvent
  | OpenNoteCreatedEvent
  | OpenNoteDepositedEvent
  | EncNoteCreatedEvent
  | NoteUsedEvent
  | ViewingKeySetEvent
  | AuditorPublicKeySetEvent
  | FeeAmountSetEvent
  | FeeCollectorSetEvent
  | ProofValidityBlocksSetEvent
  | UnknownEvent;
