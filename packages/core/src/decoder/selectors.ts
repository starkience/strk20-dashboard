import { hash } from "starknet";

/**
 * Privacy pool event names — short names as declared in
 * starknet-privacy/packages/privacy/src/events.cairo.
 * Starknet events are identified by topic0 = starknet_keccak(short_name).
 */
export const EVENT_NAMES = [
  "Deposit",
  "Withdrawal",
  "OpenNoteCreated",
  "OpenNoteDeposited",
  "EncNoteCreated",
  "NoteUsed",
  "ViewingKeySet",
  "AuditorPublicKeySet",
  "FeeAmountSet",
  "FeeCollectorSet",
  "ProofValidityBlocksSet",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

function selectorOf(name: string): string {
  // hash.getSelectorFromName already masks to 250 bits per Starknet event-selector spec.
  return normalizeHex(hash.getSelectorFromName(name));
}

/** Map event short name → topic0 selector (0x-prefixed, lowercase, no leading zeros after 0x). */
export const EVENT_SELECTORS: Record<EventName, string> = Object.fromEntries(
  EVENT_NAMES.map((name) => [name, selectorOf(name)])
) as Record<EventName, string>;

/**
 * OpenZeppelin component events the pool can emit (PausableComponent).
 * Exposed from core because core owns the starknet dependency — server
 * code must not import 'starknet' directly (it isn't in the server's
 * dependency tree; doing so crashed the container at boot).
 */
export const OZ_SELECTORS = {
  Paused: selectorOf("Paused"),
  Unpaused: selectorOf("Unpaused"),
} as const;

/** Reverse map: topic0 selector → event short name. */
export const SELECTOR_TO_NAME: Record<string, EventName> = Object.fromEntries(
  Object.entries(EVENT_SELECTORS).map(([name, selector]) => [
    selector,
    name as EventName,
  ])
);

/** Normalize a felt hex string for stable equality (lowercase, 0x prefix, strip leading zeros). */
export function normalizeHex(value: string): string {
  const stripped = value.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return "0x" + (stripped.length === 0 ? "0" : stripped);
}
