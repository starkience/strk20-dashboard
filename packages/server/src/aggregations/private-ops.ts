import type Database from "better-sqlite3";
import { EVENT_SELECTORS } from "@strk20/core";
import { countByTopicSinceIso } from "./_helpers.js";

export interface PrivateOpsCount {
  encNoteCreated: number;
  noteUsed: number;
  total: number;
}

/** Count of internal pool activity (note creations + spends) since a wall-clock ms timestamp. */
export function privateOpsSince(
  db: Database.Database,
  chain: string,
  contract: string,
  sinceMs: number
): PrivateOpsCount {
  const sinceIso = new Date(sinceMs).toISOString();
  const encNoteCreated = countByTopicSinceIso(
    db,
    chain,
    contract,
    EVENT_SELECTORS.EncNoteCreated,
    sinceIso
  );
  const noteUsed = countByTopicSinceIso(
    db,
    chain,
    contract,
    EVENT_SELECTORS.NoteUsed,
    sinceIso
  );
  return { encNoteCreated, noteUsed, total: encNoteCreated + noteUsed };
}
