/**
 * Active protocols routing through the STRK20 pool.
 *
 * Curation status (2026-06-01):
 *
 *   AVNU   — CONFIRMED INTEGRATED. The Forwarder address below accounts for
 *            ~88% of all withdrawal events on the pool today: it's the
 *            paymaster that broadcasts users' withdrawals so recipient
 *            addresses don't need pre-funding (a fundamental privacy property
 *            of the pool — pre-funding would be a deanonymization signal).
 *            All 3 published addresses are registered for completeness.
 *
 *   Ekubo  — Router + Core registered. AMM; users may route swaps through
 *            Ekubo before depositing, but Ekubo contracts don't directly
 *            call deposit/withdraw on the pool. Likely to stay near-zero
 *            unless an Ekubo-mediated direct flow ships.
 *
 *   Vesu, Endur, Troves — TOKEN-GRAPH integrations: their tokens appear in
 *            the pool's TVL (Endur LSTs, Vesu vault tokens, Troves vault
 *            strategies) but their contracts don't directly call the pool.
 *            Left with empty addresses and `needsCuration: true` until/unless
 *            a router-mediated flow ships. Their relationship to the pool
 *            is asset-level, not call-level.
 *
 *   OFFMARKET — CONFIRMED INTEGRATED. Dedicated inbound and outbound
 *            anonymizers bridge the privacy pool to its Polymarket flow.
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
  /** True if no on-chain addresses are registered yet for attribution. */
  needsCuration: boolean;
  /**
   * How the protocol relates to the pool. Lets the UI distinguish a
   * paymaster/router (calls the pool) from a token issuer or AMM whose
   * tokens flow through the pool via users.
   */
  integrationType:
    | "paymaster"
    | "router"
    | "amm"
    | "token-issuer"
    | "vault"
    | "pending";
}

export const PROTOCOLS: ProtocolDefinition[] = [
  {
    id: "avnu",
    label: "AVNU",
    addresses: [
      // Forwarder (paymaster) — broadcasts ~88% of withdrawals so recipients don't pay gas
      "0x0127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
    ],
    needsCuration: false,
    integrationType: "paymaster",
  },
  {
    id: "avnu-dex",
    label: "AVNU DEX",
    addresses: [
      // Exchange router (swap aggregator)
      "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f",
      // DCA orchestrator (time-based orders)
      "0x0492139c56af6faf77119b6bca3b6d40f559af6b7b23778f068dd9ca08e407c5",
    ],
    needsCuration: false,
    integrationType: "router",
  },
  {
    id: "ekubo",
    label: "Ekubo",
    addresses: [
      // Ekubo Core
      "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      // Router V3.0.13
      "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e",
    ],
    needsCuration: false,
    integrationType: "amm",
  },
  {
    id: "offmarket",
    label: "OFFMARKET",
    addresses: [
      // OutboundAnonymizer
      "0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092",
      // InboundAnonymizer
      "0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb",
    ],
    needsCuration: false,
    integrationType: "router",
  },
  {
    id: "vesu",
    label: "Vesu",
    addresses: [],
    needsCuration: true,
    integrationType: "pending",
  },
  {
    id: "endur",
    label: "Endur",
    addresses: [],
    needsCuration: true,
    integrationType: "token-issuer",
  },
  {
    id: "troves",
    label: "Troves",
    addresses: [],
    needsCuration: true,
    integrationType: "vault",
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
