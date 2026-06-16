import type { StarkscanClient } from "@strk20/core";
import type { EventCache } from "./cache/index.js";

export interface SyncResult {
  phase: "backfill" | "catchup";
  pagesFetched: number;
  eventsInserted: number;
  lastBlock: number | null;
  backfillComplete: boolean;
}

/**
 * Two-phase event sync.
 *
 * Phase 1 — backfill: walk the contract's full history newest→oldest, resuming
 * from the saved cursor across calls, until Starkscan returns no nextCursor.
 * Then it's marked complete and never re-walked.
 *
 * Phase 2 — catch-up: once backfilled, each call fetches the newest events and
 * descends until it reaches the block we have contiguous coverage down to
 * (the "anchor"). If a single call runs out of page budget before bridging the
 * gap, it persists its cursor and resumes from there next call, so a burst
 * larger than one tick's budget gets filled over several ticks instead of
 * being silently abandoned.
 *
 * Cursor pagination on Starkscan goes newest→older. INSERT OR IGNORE dedupes,
 * so overlap between phases is harmless.
 *
 * NB: the API clamps page size to 100, so 100 is the effective max per page.
 */
export async function syncContractEvents(
  client: StarkscanClient,
  cache: EventCache,
  chain: string,
  contract: string,
  opts: { pageSize?: number; maxPages?: number } = {}
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 100;
  const state = cache.readSyncState(chain, contract);

  if (!state?.backfillComplete) {
    return backfill(client, cache, chain, contract, state?.lastCursor ?? null, pageSize, maxPages);
  }
  return catchUp(client, cache, chain, contract, pageSize, maxPages);
}

async function backfill(
  client: StarkscanClient,
  cache: EventCache,
  chain: string,
  contract: string,
  startCursor: string | null,
  pageSize: number,
  maxPages: number
): Promise<SyncResult> {
  let cursor: string | null = startCursor;
  let pages = 0;
  let inserted = 0;
  let lastBlock: number | null = cache.latestBlock(chain, contract);
  let complete = false;

  while (pages < maxPages) {
    const page = await client.contractEvents(contract, { limit: pageSize, cursor });
    if (page.items.length > 0) {
      inserted += cache.insertMany(chain, contract, page.items);
      lastBlock = Math.max(lastBlock ?? 0, page.items[0]!.blockNumber);
    }
    pages += 1;
    cursor = page.nextCursor;
    // Completion is signalled ONLY by a null nextCursor — an empty page with a
    // live cursor is a transient gap, not the end of history. Marking complete
    // on an empty page would permanently abandon everything below it.
    if (!cursor) {
      complete = true;
      break;
    }
  }

  cache.recordSyncState(chain, contract, lastBlock, cursor, complete);
  return {
    phase: "backfill",
    pagesFetched: pages,
    eventsInserted: inserted,
    lastBlock,
    backfillComplete: complete,
  };
}

async function catchUp(
  client: StarkscanClient,
  cache: EventCache,
  chain: string,
  contract: string,
  pageSize: number,
  maxPages: number
): Promise<SyncResult> {
  const state = cache.readSyncState(chain, contract);
  // Anchor = the block we have CONTIGUOUS coverage down to. Held stable across
  // resume ticks (it's the last block of an uninterrupted run from the head),
  // so a gap larger than one tick's page budget is filled over several ticks
  // by resuming from the saved cursor — not abandoned by jumping back to head.
  const anchor = state?.lastSyncedBlock ?? cache.latestBlock(chain, contract);
  // Resume mid-descent if the previous tick ran out of budget; else start fresh
  // at the head (null cursor).
  let cursor: string | null = state?.lastCursor ?? null;
  let pages = 0;
  let inserted = 0;
  let caughtUp = false;

  while (pages < maxPages) {
    const page = await client.contractEvents(contract, { limit: pageSize, cursor });
    if (page.items.length > 0) {
      inserted += cache.insertMany(chain, contract, page.items);
      const oldestInPage = page.items[page.items.length - 1]!.blockNumber;
      cursor = page.nextCursor;
      pages += 1;
      // Bridged down into already-covered territory → fully caught up.
      if (anchor != null && oldestInPage <= anchor) {
        caughtUp = true;
        break;
      }
    } else {
      cursor = page.nextCursor;
      pages += 1;
    }
    if (!cursor) {
      caughtUp = true; // walked the entire feed
      break;
    }
  }

  // After bridging the gap the cache is contiguous up to the live head, so
  // latestBlock IS the true head; adopt it as the new anchor and clear the
  // cursor. Otherwise keep the same anchor and persist the live cursor so the
  // next tick resumes the descent instead of restarting at the head.
  const head = cache.latestBlock(chain, contract);
  if (caughtUp) {
    cache.recordSyncState(chain, contract, head, null, true);
  } else {
    cache.recordSyncState(chain, contract, anchor, cursor, true);
  }

  return {
    phase: "catchup",
    pagesFetched: pages,
    eventsInserted: inserted,
    lastBlock: head,
    backfillComplete: true,
  };
}
