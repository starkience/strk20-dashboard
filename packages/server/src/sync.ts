import type { StarkscanClient } from "@strk20/core";
import type { EventCache } from "./cache/index.js";

export interface SyncResult {
  pagesFetched: number;
  eventsInserted: number;
  lastBlock: number | null;
}

/**
 * Pull events for a contract from Starkscan into the local cache.
 * On first run: walks the full history (paginated). On subsequent runs:
 * stops once a page contains an event at or below the latest cached block.
 *
 * Cursor pagination on Starkscan goes newest → older, so we walk back until
 * we've seen the previous high-water mark.
 */
export async function syncContractEvents(
  client: StarkscanClient,
  cache: EventCache,
  chain: string,
  contract: string,
  opts: { pageSize?: number; maxPages?: number } = {}
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const highWater = cache.latestBlock(chain, contract);

  let cursor: string | null = null;
  let pages = 0;
  let inserted = 0;
  let lastBlockSeen: number | null = null;
  let stop = false;

  while (!stop && pages < maxPages) {
    const page = await client.contractEvents(contract, {
      limit: pageSize,
      cursor,
    });

    if (page.items.length === 0) break;

    inserted += cache.insertMany(chain, contract, page.items);
    const oldestInPage = page.items[page.items.length - 1]!.blockNumber;
    const newestInPage = page.items[0]!.blockNumber;
    lastBlockSeen = Math.max(lastBlockSeen ?? 0, newestInPage);
    pages += 1;

    if (highWater != null && oldestInPage <= highWater) {
      stop = true;
      break;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  cache.recordSyncState(chain, contract, lastBlockSeen, cursor);
  return { pagesFetched: pages, eventsInserted: inserted, lastBlock: lastBlockSeen };
}
