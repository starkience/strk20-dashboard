/** Public and STRK20-shadow activity at three partner apps.
 *
 * "Private" means an action by a deployed STRK20 shadow account. It does
 * not imply that the app-side amount, position, or address is hidden onchain.
 * The two rows are disjoint: public excludes shadow-account activity.
 */
import { normalizeHex, selectorOf, type RawContractEvent, type StarkscanClient } from "@strk20/core";
import { SHADOW_ANONYMIZER, SHADOW_DEPLOYED } from "./troves-shadow.js";

const OPUS_ABBOT = "0x04d0bb0a4c40012384e7c419e6eb3c637b28e8363fb66958b60d90505b9c072f";
const OPUS_SHRINE = "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada";
const OPUS_ABSORBER = "0x000a5e1c1ffe1384b30a464a61b1af631e774ec52c0e7841b9b5f02c6a729bc0";
const ARCX_REGISTRY = "0x37ad81bcfa789e849216f5ea973c6ac22b5c9cdb05c29e9d5667252440d8300";
const ARCX_API = "https://arcx-prod-strategy-cf.d.karnot.xyz/api";
const SUPERVEGA_ACTIVITY = "https://supervega.app/api/activity?chain=mainnet";
const REFRESH_MS = 2 * 60_000;
const STALE_MS = 10 * 60_000;
const MAX_EVENT_PAGES = 500;
const MAX_FILL_PAGES = 500;

export type AppId = "opus" | "supervega" | "arcx";
export interface AppFlowMetric {
  status: "live" | "indexing" | "stale" | "unavailable";
  unit: "actions" | "usd";
  basis: string;
  public: number | null;
  private: number | null;
  asOf: string | null;
  privateDays: { date: string; value: number }[] | null;
  privateActionDays?: { date: string; value: number }[] | null;
  actionBasis?: string | undefined;
}
type Values = Omit<AppFlowMetric, "status" | "asOf">;
type ShadowAccount = { block: number; deployedAt: number };
type ShadowMap = Map<string, ShadowAccount>;
type EventsClient = Pick<StarkscanClient, "status" | "contractEvents">;

function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(value) || BigInt(value) === 0n) {
    throw Error("Invalid app-flow address");
  }
  return normalizeHex(value);
}

function timestamp(value: unknown): number {
  const n = typeof value === "number" ? value * 1000 : Date.parse(String(value));
  if (!Number.isFinite(n)) throw Error("Invalid app-flow timestamp");
  return n;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Error("Invalid app-flow amount");
  }
  return value;
}

function shadowAtTime(shadows: ShadowMap, actor: unknown, timeMs: number): boolean {
  const deployed = shadows.get(address(actor));
  return deployed != null && deployed.deployedAt <= timeMs;
}
function shadowAtBlock(shadows: ShadowMap, actor: unknown, block: number): boolean {
  if (typeof actor !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(actor) || BigInt(actor) === 0n) return false;
  const deployed = shadows.get(normalizeHex(actor));
  return deployed != null && deployed.block <= block;
}

function daily(map: Map<string, number>): { date: string; value: number }[] {
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}
function addDay(map: Map<string, number>, iso: string, amount: number): void {
  const date = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("Invalid app-flow day");
  map.set(date, (map.get(date) ?? 0) + amount);
}

async function allEvents(client: EventsClient, contract: string, topic0: string, head: number): Promise<RawContractEvent[]> {
  const result: RawContractEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const body = await client.contractEvents(contract, { limit: 100, topic0, cursor });
    if (!Array.isArray(body?.items) || !(body.nextCursor === null || typeof body.nextCursor === "string")) {
      throw Error("Invalid Starkscan app-flow event page");
    }
    if (body.nextCursor && body.nextCursor === cursor) throw Error("Starkscan app-flow cursor did not advance");
    for (const event of body.items) {
      if (normalizeHex(event.address) !== normalizeHex(contract) || normalizeHex(event.topic0) !== normalizeHex(topic0)) {
        throw Error("Out-of-scope Starkscan app-flow event");
      }
      if (!Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) throw Error("Invalid event block");
      if (event.blockNumber > head) continue;
      const key = `${event.blockNumber}:${event.txIndex}:${event.logIndex}`;
      if (!seen.has(key)) { seen.add(key); result.push(event); }
    }
    cursor = body.nextCursor;
    if (cursor === null) return result;
  }
  throw Error("Starkscan app-flow history exceeded page limit");
}

export async function loadShadowAccounts(client: EventsClient, head: number): Promise<ShadowMap> {
  const events = await allEvents(client, SHADOW_ANONYMIZER, SHADOW_DEPLOYED, head);
  if (events.length === 0) throw Error("Shadow-account deployment history unavailable");
  const accounts: ShadowMap = new Map();
  for (const event of events) {
    const key = address(event.topic2);
    const item = { block: event.blockNumber, deployedAt: timestamp(event.timestampIso) };
    const existing = accounts.get(key);
    if (!existing || item.block < existing.block) accounts.set(key, item);
  }
  return accounts;
}

export async function opusPositionActions(client: EventsClient, head: number, shadows: ShadowMap): Promise<Values> {
  const [deposits, withdrawals, opened, forged, repaid, provided, removed, reaped] = await Promise.all([
    allEvents(client, OPUS_ABBOT, selectorOf("Deposit"), head),
    allEvents(client, OPUS_ABBOT, selectorOf("Withdraw"), head),
    allEvents(client, OPUS_ABBOT, selectorOf("TroveOpened"), head),
    allEvents(client, OPUS_SHRINE, selectorOf("Forge"), head),
    allEvents(client, OPUS_SHRINE, selectorOf("Melt"), head),
    allEvents(client, OPUS_ABSORBER, selectorOf("Provide"), head),
    allEvents(client, OPUS_ABSORBER, selectorOf("Remove"), head),
    allEvents(client, OPUS_ABSORBER, selectorOf("Reap"), head),
  ]);
  if (opened.length === 0 || deposits.length + withdrawals.length + forged.length + repaid.length === 0) {
    throw Error("Opus position event history unavailable");
  }
  const owners = new Map<string, { actor: string; openedBlock: number }>();
  for (const event of opened) {
    const id = address(event.topic2);
    const actor = address(event.topic1);
    const previous = owners.get(id);
    if (previous && previous.actor !== actor) throw Error("Conflicting Opus Trove owners");
    owners.set(id, { actor, openedBlock: event.blockNumber });
  }
  let publicActions = 0, privateActions = 0;
  const privateDays = new Map<string, number>();
  const count = (actor: string, block: number, iso: string) => {
    const deployment = shadows.get(actor);
    if (deployment && deployment.block <= block) { privateActions++; addDay(privateDays, iso, 1); }
    else publicActions++;
  };
  for (const event of [...deposits, ...withdrawals]) {
    count(address(event.topic1), event.blockNumber, event.timestampIso);
  }
  for (const event of [...provided, ...removed, ...reaped]) {
    count(address(event.topic1), event.blockNumber, event.timestampIso);
  }
  for (const event of [...forged, ...repaid]) {
    const trove = address(event.topic1);
    const owner = owners.get(trove);
    // Shrine includes a few historical system debt events that predate the
    // Abbot's ownership record for the same Trove ID. Their actor cannot be
    // verified, so they belong in neither displayed slice.
    if (!owner || owner.openedBlock > event.blockNumber) continue;
    count(owner.actor, event.blockNumber, event.timestampIso);
  }
  return { unit: "actions", basis: "finalized Opus collateral, CASH debt, and Absorber savings actions", public: publicActions, private: privateActions, privateDays: daily(privateDays) };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`App-flow source HTTP ${response.status}`);
  return response.json();
}

export async function arcxTradeVolume(fetchImpl: typeof fetch, shadows: ShadowMap): Promise<Values> {
  const markets = await getJson(fetchImpl, `${ARCX_API}/ct-markets`);
  if (!Array.isArray(markets) || markets.length === 0) throw Error("ArcX market catalogue unavailable");
  let publicUsd = 0, privateUsd = 0, fills = 0;
  const privateDays = new Map<string, number>();
  const privateActionDays = new Map<string, number>();
  const seenMarkets = new Set<string>();
  for (const market of markets) {
    if (!market || typeof market.id !== "string" || seenMarkets.has(market.id)
        || market.quoteTokenSymbol !== "USDC" || market.quoteTokenDecimals !== 6) {
      throw Error("Unsupported ArcX market metadata");
    }
    seenMarkets.add(market.id);
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const seenFills = new Set<string>();
    for (let page = 0; page < MAX_FILL_PAGES; page++) {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const body = await getJson(fetchImpl, `${ARCX_API}/ct-markets/${encodeURIComponent(market.id)}/fills${suffix}`) as {fills?: unknown; cursor?: unknown};
      if (!Array.isArray(body?.fills) || !(body.cursor === null || typeof body.cursor === "string")) {
        throw Error("Invalid ArcX fills page");
      }
      for (const fill of body.fills) {
        if (!fill || typeof fill.fillId !== "string" || typeof fill.quoteRaw !== "string"
            || !/^\d+$/.test(fill.quoteRaw) || !fill.createdAt) throw Error("Invalid ArcX fill");
        if (seenFills.has(fill.fillId)) continue;
        seenFills.add(fill.fillId);
        const usd = Number(BigInt(fill.quoteRaw)) / 1e6;
        if (!Number.isFinite(usd)) throw Error("Invalid ArcX USDC amount");
        const timeMs = timestamp(fill.createdAt);
        const isPrivate = shadowAtTime(shadows, fill.maker, timeMs) || shadowAtTime(shadows, fill.taker, timeMs);
        if (isPrivate) { privateUsd += usd; addDay(privateDays, fill.createdAt, usd); addDay(privateActionDays, fill.createdAt, 1); }
        else publicUsd += usd;
        fills++;
      }
      cursor = body.cursor;
      if (cursor === null) break;
      if (seenCursors.has(cursor)) throw Error("ArcX fills cursor did not advance");
      seenCursors.add(cursor);
      if (page === MAX_FILL_PAGES - 1) throw Error("ArcX fills exceeded page limit");
    }
  }
  if (fills === 0) throw Error("ArcX fills history unavailable");
  return { unit: "usd", basis: "ArcX USDC fills, any shadow-account counterparty", public: publicUsd, private: privateUsd,
    privateDays: daily(privateDays), privateActionDays: daily(privateActionDays), actionBasis: "ArcX USDC fills" };
}

/** ArcX's Registry is the source of vault-token membership. Transfers capture
 * deposits, withdrawals and direct transfers involving a deployed shadow.
 * They are action counts, never added to CreditToken fill USD volume.
 */
export async function arcxVtokenActions(client: EventsClient, head: number, shadows: ShadowMap) {
  const registered = (await Promise.all(["VTokenAdded", "OmnichainVTokenAdded"].map(name =>
    allEvents(client, ARCX_REGISTRY, selectorOf(name), head)))).flat();
  if (!registered.length) throw Error("ArcX vToken registry unavailable");
  const tokens = new Set<string>();
  for (const event of registered) tokens.add(address(event.topic1));
  if (tokens.size !== registered.length) throw Error("Duplicate ArcX vToken registration");
  const streams = await Promise.all([...tokens].map(token => allEvents(client, token, selectorOf("Transfer"), head)));
  const days = new Map<string, number>();
  for (const events of streams) for (const event of events) {
    if (event.keys?.length !== 3 || event.data.length !== 2) throw Error("Invalid ArcX vToken Transfer");
    if (shadowAtBlock(shadows, event.topic1, event.blockNumber)
        || shadowAtBlock(shadows, event.topic2, event.blockNumber)) addDay(days, event.timestampIso, 1);
  }
  return { days: daily(days), tokens: tokens.size };
}

async function arcxCombined(client: EventsClient, head: number, fetchImpl: typeof fetch, shadows: ShadowMap): Promise<Values> {
  const [fills, vaults] = await Promise.all([arcxTradeVolume(fetchImpl, shadows), arcxVtokenActions(client, head, shadows)]);
  const actionDays = new Map<string, number>();
  for (const day of [...(fills.privateActionDays ?? []), ...vaults.days]) addDay(actionDays, day.date, day.value);
  return { ...fills, privateActionDays: daily(actionDays),
    actionBasis: `ArcX USDC fills and ${vaults.tokens} registered vToken Transfer streams` };
}

export async function supervegaPremiums(fetchImpl: typeof fetch, shadows: ShadowMap): Promise<Values> {
  const activity = await getJson(fetchImpl, SUPERVEGA_ACTIVITY);
  if (!Array.isArray(activity) || activity.length === 0) throw Error("Supervega activity history unavailable");
  const seen = new Set<string>();
  let publicUsd = 0, privateUsd = 0, buys = 0;
  const privateDays = new Map<string, number>();
  const privateActionDays = new Map<string, number>();
  for (const entry of activity) {
    if (entry?.kind !== "buy" && entry?.kind !== "exercise") continue;
    if (typeof entry.txHash !== "string" || typeof entry.entryId !== "string") throw Error("Invalid Supervega purchase");
    const key = `${entry.kind}:${entry.txHash}:${entry.actor}:${entry.entryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const timeMs = timestamp(entry.ts);
    const privateActor = shadowAtTime(shadows, entry.actor, timeMs);
    if (privateActor) addDay(privateActionDays, new Date(timeMs).toISOString(), 1);
    if (entry.kind === "exercise") continue;
    const usd = number(entry.premiumUsd);
    if (privateActor) { privateUsd += usd; addDay(privateDays, new Date(timeMs).toISOString(), usd); }
    else publicUsd += usd;
    buys++;
  }
  if (buys === 0) throw Error("Supervega purchase history unavailable");
  return { unit: "usd", basis: "Supervega option purchase premiums", public: publicUsd, private: privateUsd,
    privateDays: daily(privateDays), privateActionDays: daily(privateActionDays), actionBasis: "Supervega option purchases and exercises" };
}

export function createAppFlowService(opts: {client: EventsClient; chain: string; fetchImpl?: typeof fetch; now?: () => number}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ids: AppId[] = ["opus", "supervega", "arcx"];
  const values = new Map<AppId, {data: Values; updatedAt: number}>();
  const failures = new Set<AppId>();
  let busy = false;
  async function refresh(): Promise<void> {
    if (busy || opts.chain !== "SN_MAIN") return;
    busy = true;
    try {
      const status = await opts.client.status();
      const head = Math.min(status.finalizedBlockNumber, status.latestIndexedBlockNumber);
      if (!Number.isSafeInteger(head) || head <= 0) throw Error("Starkscan finalized head unavailable");
      const shadows = await loadShadowAccounts(opts.client, head);
      const tasks: [AppId, Promise<Values>][] = [
        ["opus", opusPositionActions(opts.client, head, shadows)],
        ["supervega", supervegaPremiums(fetchImpl, shadows)],
        ["arcx", arcxCombined(opts.client, head, fetchImpl, shadows)],
      ];
      const results = await Promise.allSettled(tasks.map(([, task]) => task));
      results.forEach((result, index) => {
        const id = tasks[index]![0];
        if (result.status === "fulfilled") {
          values.set(id, {data: result.value, updatedAt: now()});
          failures.delete(id);
        } else {
          failures.add(id);
          console.error(`app-flows ${id}:`, result.reason);
        }
      });
    } catch (error) {
      ids.forEach(id => failures.add(id));
      console.error("app-flows:", error);
    } finally {
      busy = false;
    }
  }
  function snapshot() {
    const apps = {} as Record<AppId, AppFlowMetric>;
    for (const id of ids) {
      const entry = values.get(id);
      const fresh = entry && now() - entry.updatedAt <= STALE_MS;
      apps[id] = {
        status: fresh ? "live" : entry ? "stale" : failures.has(id) ? "unavailable" : "indexing",
        unit: entry?.data.unit ?? (id === "opus" ? "actions" : "usd"),
        basis: entry?.data.basis ?? "",
        public: fresh ? entry.data.public : null,
        private: fresh ? entry.data.private : null,
        asOf: entry ? new Date(entry.updatedAt).toISOString() : null,
        privateDays: fresh ? entry.data.privateDays : null,
        privateActionDays: fresh ? entry.data.privateActionDays ?? null : null,
        actionBasis: entry?.data.actionBasis,
      };
    }
    return { schemaVersion: 1, scope: "partner-app-public-and-strk20-shadow-flows", apps };
  }
  function start(): void {
    if (opts.chain !== "SN_MAIN") return;
    void refresh();
    setInterval(() => void refresh(), REFRESH_MS);
  }
  return { refresh, snapshot, start };
}
