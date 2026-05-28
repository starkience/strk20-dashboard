/**
 * Aggregation queries against the SQLite event cache.
 *
 * Each metric lives in its own file so consumers can import narrowly:
 *   import { anonymitySet } from "@strk20/server/aggregations/anonymity-set";
 *   import { currentTvl }   from "@strk20/server/aggregations/tvl";
 *
 * All functions take a `Database` handle (better-sqlite3) plus a chain id +
 * contract address, so they're trivially mountable in any server framework.
 */

export * from "./anonymity-set.js";
export * from "./private-ops.js";
export * from "./depositors.js";
export * from "./note-ages.js";
export * from "./tvl.js";
export * from "./protocols.js";
