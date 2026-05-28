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
 * stops as soon as it reaches a block we already have. Cheap; for the interval.
 *
 * Cursor pagination on Starkscan goes newest→older. INSERT OR IGNORE dedupes,
 * so overlap between phases is harmless.
 */
export async function syncContractEvents(
  client: StarkscanClient,
  cache: EventCache,
  chain: string,
  contract: string,
  opts: { pageSize?: number; maxPages?: number } = {}
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 50;
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
    if (page.items.length === 0) {
      complete = true;
      break;
    }
    inserted += cache.insertMany(chain, contract, page.items);
    lastBlock = Math.max(lastBlock ?? 0, page.items[0]!.blockNumber);
    pages += 1;
    cursor = page.nextCursor;
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
  const highWater = cache.latestBlock(chain, contract);
  let cursor: string | null = null;
  let pages = 0;
  let inserted = 0;
  let lastBlock: number | null = highWater;

  while (pages < maxPages) {
    const page = await client.contractEvents(contract, { limit: pageSize, cursor });
    if (page.items.length === 0) break;
    inserted += cache.insertMany(chain, contract, page.items);
    const oldestInPage = page.items[page.items.length - 1]!.blockNumber;
    lastBlock = Math.max(lastBlock ?? 0, page.items[0]!.blockNumber);
    pages += 1;
    if (highWater != null && oldestInPage <= highWater) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  cache.recordSyncState(chain, contract, lastBlock, null, true);
  return {
    phase: "catchup",
    pagesFetched: pages,
    eventsInserted: inserted,
    lastBlock,
    backfillComplete: true,
  };
}
