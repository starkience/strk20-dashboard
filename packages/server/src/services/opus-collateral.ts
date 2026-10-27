/** Financial Opus position measure from the protocol's own finalized reads.
 * The Shrine returns USD collateral value and CASH debt for every Trove. Only
 * Troves opened by already-deployed STRK20 shadow accounts enter the private
 * slice; the public row is the Shrine total less that slice.
 */
import { normalizeHex, selectorOf, type StarkscanClient } from "@strk20/core";
import { loadShadowAccounts } from "./app-flows.js";

const ABBOT = "0x04d0bb0a4c40012384e7c419e6eb3c637b28e8363fb66958b60d90505b9c072f";
const SHRINE = "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada";
const REFRESH_MS = 120_000;
const STALE_MS = 10 * 60_000;
type Reader = Pick<StarkscanClient, "status" | "contractEvents" | "contractRead">;
type Values = { public: number; private: number; publicDebtCash: number; privateDebtCash: number; shadowTroves: number; asOfBlock: number };

function wad(raw: string): number {
  const amount = BigInt(raw);
  if (amount < 0n) throw Error("Invalid Opus Wad");
  const value = Number(amount) / 1e18;
  if (!Number.isFinite(value)) throw Error("Invalid Opus amount");
  return value;
}
function health(result: string[]): { value: number; debt: number } {
  if (!Array.isArray(result) || result.length !== 4) throw Error("Invalid Opus health response");
  return { value: wad(result[2]!), debt: wad(result[3]!) };
}

export async function measureOpusCollateral(client: Reader): Promise<Values> {
  const status = await client.status();
  const head = Math.min(status.finalizedBlockNumber, status.latestIndexedBlockNumber);
  if (!Number.isSafeInteger(head) || head <= 0) throw Error("Opus finalized head unavailable");
  const shadows = await loadShadowAccounts(client, head);
  const ids = new Map<string, { owner: string; openedBlock: number }>();
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const response = await client.contractEvents(ABBOT, { topic0: selectorOf("TroveOpened"), limit: 100, cursor });
    if (!Array.isArray(response?.items) || !(response.nextCursor === null || typeof response.nextCursor === "string")) throw Error("Invalid Opus Trove page");
    if (response.nextCursor && response.nextCursor === cursor) throw Error("Opus Trove cursor did not advance");
    for (const event of response.items) {
      if (normalizeHex(event.address) !== normalizeHex(ABBOT) || normalizeHex(event.topic0) !== normalizeHex(selectorOf("TroveOpened"))
          || !Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) throw Error("Invalid Opus Trove event");
      if (event.blockNumber > head) continue;
      if (!event.topic1 || !event.topic2) throw Error("Missing Opus Trove owner");
      const owner = normalizeHex(event.topic1), id = normalizeHex(event.topic2);
      const previous = ids.get(id);
      if (previous && previous.owner !== owner) throw Error("Conflicting Opus Trove owners");
      if (!previous || event.blockNumber < previous.openedBlock) ids.set(id, { owner, openedBlock: event.blockNumber });
    }
    cursor = response.nextCursor;
    if (cursor === null) break;
    if (page === 499) throw Error("Opus Trove history exceeded page limit");
  }
  if (!ids.size) throw Error("Opus Trove history unavailable");
  const blockTag = String(head);
  const total = health((await client.contractRead(SHRINE, selectorOf("get_shrine_health"), { blockTag })).result);
  let privateValue = 0, privateDebt = 0, shadowTroves = 0;
  for (const [id, trove] of ids) {
    const shadow = shadows.get(trove.owner);
    if (!shadow || shadow.block > trove.openedBlock) continue;
    const result = health((await client.contractRead(SHRINE, selectorOf("get_trove_health"), { calldata: [id], blockTag })).result);
    privateValue += result.value;
    privateDebt += result.debt;
    shadowTroves++;
  }
  if (privateValue > total.value + 0.01 || privateDebt > total.debt + 0.01) throw Error("Opus private position exceeds Shrine total");
  return { public: Math.max(0, total.value - privateValue), private: privateValue,
    publicDebtCash: Math.max(0, total.debt - privateDebt), privateDebtCash: privateDebt,
    shadowTroves, asOfBlock: head };
}

export function createOpusCollateralService(opts: { client: Reader; chain: string; now?: () => number }) {
  const now = opts.now ?? Date.now;
  let current: { value: Values; updatedAt: number } | null = null;
  let failed = false, busy = false;
  async function refresh() {
    if (busy || opts.chain !== "SN_MAIN") return;
    busy = true;
    try { current = { value: await measureOpusCollateral(opts.client), updatedAt: now() }; failed = false; }
    catch (error) { failed = true; console.error("opus-collateral:", error); }
    finally { busy = false; }
  }
  function snapshot() {
    const live = current != null && now() - current.updatedAt <= STALE_MS;
    return { schemaVersion: 1, protocol: "opus", scope: "shrine-collateral-by-strk20-shadow-troves",
      status: live ? "live" : current ? "stale" : failed ? "unavailable" : "indexing",
      unit: "usd", basis: "Opus Shrine collateral value at the finalized block",
      public: live ? current!.value.public : null, private: live ? current!.value.private : null,
      publicDebtCash: live ? current!.value.publicDebtCash : null,
      privateDebtCash: live ? current!.value.privateDebtCash : null,
      shadowTroves: live ? current!.value.shadowTroves : null,
      asOfBlock: live ? current!.value.asOfBlock : null,
      asOf: current ? new Date(current.updatedAt).toISOString() : null };
  }
  function start() { if (opts.chain === "SN_MAIN") { void refresh(); setInterval(() => void refresh(), REFRESH_MS); } }
  return { refresh, snapshot, start };
}
