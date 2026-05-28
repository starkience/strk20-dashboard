/**
 * Active protocols routing through the STRK20 pool.
 *
 * The address values below are SEED ENTRIES — they need curation against the
 * real addresses these protocols use as deposit/withdrawal callers on the pool.
 * Use the `/agg/top-callers` discovery endpoint to identify which addresses are
 * actually showing up in `Deposit` / `Withdrawal` events, then map them here.
 *
 * Each protocol can have multiple addresses (router + paymaster + vault, etc).
 * The classifier matches against any of them.
 */

export interface ProtocolDefinition {
  /** Stable internal id used in API responses + UI module keys. */
  id: string;
  /** Display label shown on the constellation satellite. */
  label: string;
  /** Addresses associated with the protocol. All lowercase, 0x-prefixed. */
  addresses: string[];
  /** TODO: replace with confirmed addresses when curated. */
  needsCuration: boolean;
}

export const PROTOCOLS: ProtocolDefinition[] = [
  {
    id: "avnu",
    label: "AVNU",
    // TODO curate — AVNU has a router + paymaster set; verify against /agg/top-callers
    addresses: [],
    needsCuration: true,
  },
  {
    id: "vesu",
    label: "Vesu",
    // TODO curate — Vesu has multiple pool addresses
    addresses: [],
    needsCuration: true,
  },
  {
    id: "endur",
    label: "Endur",
    addresses: [],
    needsCuration: true,
  },
  {
    id: "ekubo",
    label: "Ekubo",
    // TODO curate — Ekubo Core + extensions; the address commonly cited is below but verify
    addresses: [],
    needsCuration: true,
  },
  {
    id: "troves",
    label: "Troves",
    addresses: [],
    needsCuration: true,
  },
];

/** Normalize an on-chain address for stable equality. */
export function normalizeAddress(addr: string): string {
  const s = addr.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return "0x" + (s.length === 0 ? "0" : s);
}

const ADDRESS_TO_PROTOCOL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const p of PROTOCOLS) {
    for (const a of p.addresses) m.set(normalizeAddress(a), p.id);
  }
  return m;
})();

/** Returns protocol id if the address is registered, null otherwise. */
export function protocolForAddress(address: string): string | null {
  return ADDRESS_TO_PROTOCOL.get(normalizeAddress(address)) ?? null;
}
