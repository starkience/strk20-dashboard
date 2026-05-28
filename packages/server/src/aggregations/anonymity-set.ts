import type Database from "better-sqlite3";
import { EVENT_SELECTORS } from "@strk20/core";
import { countByTopic } from "./_helpers.js";

export interface AnonymitySet {
  created: number;
  used: number;
  unspent: number;
}

/** Anonymity set = note commitments created minus nullifiers (spent notes). */
export function anonymitySet(
  db: Database.Database,
  chain: string,
  contract: string
): AnonymitySet {
  const created = countByTopic(db, chain, contract, EVENT_SELECTORS.EncNoteCreated);
  const used = countByTopic(db, chain, contract, EVENT_SELECTORS.NoteUsed);
  return { created, used, unspent: created - used };
}
