/** Troves vault activity by deployed STRK20 shadow accounts.
 * Starkscan supplies finalized event history and class-ABI decoded fields.
 * The public Troves catalogue supplies vault membership, never usage counts.
 * No main-wallet attribution or dollar valuation is inferred.
 */
import { createHash } from "node:crypto";
import { normalizeHex, selectorOf, type RawContractEvent, type StarkscanClient } from "@strk20/core";
import type { Db } from "../cache/db.js";

export const SHADOW_ANONYMIZER = "0x4f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7";
export const SHADOW_DEPLOYED = selectorOf("ShadowAccountDeployed");
export const TROVES_CATALOGUE = "https://app.troves.fi/api/strategies";
const MAX_AGE_MS = 10 * 60_000;
const KINDS: Record<string, string> = {
  Deposit: "deposit", Withdraw: "withdraw", Redeem: "withdraw",
  RedeemRequested: "withdraw_request", RedeemClaimed: "withdraw_claim",
};
const TOPICS = [...Object.keys(KINDS), "ERC4626Event"].map(selectorOf);
const CATALOG_KEY = (chain: string) => `troves:catalog:${chain}`;
const FACTORY_KEY = (chain: string) => `troves:factory:${chain}`;
export interface Vault { address: string; id: string; name: string }
interface Catalogue { vaults: Vault[]; excludedStrategyIds: string[] }
export interface StreamState {
  coveredBlock: number | null;
  fromBlock: number; targetBlock: number | null; cursor: string | null;
  completedAt: number | null;
}
export function readState<T>(db: Db, key: string): T | null {
  const row = db.prepare("SELECT value_json FROM shadow_index_state WHERE key=?").get(key) as {value_json: string} | undefined;
  return row ? JSON.parse(row.value_json) as T : null;
}
export function saveState(db: Db, key: string, value: unknown): void {
  db.prepare(`INSERT INTO shadow_index_state(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now());
}
export function parseCatalogue(body: unknown): Catalogue {
  const data = body as {status?: boolean; strategies?: {id: string; name: string; contract?: {name: string; address: string}[]}[]};
  if (data?.status !== true || !Array.isArray(data.strategies) || data.strategies.length === 0) throw Error("Troves catalogue unavailable");
  const vaults: Vault[] = [], excludedStrategyIds: string[] = [];
  for (const strategy of data.strategies) {
    const vault = strategy.contract?.find((c) => c.name === "Vault");
    if (!vault) { excludedStrategyIds.push(strategy.id); continue; }
    if (!/^0x[0-9a-f]{1,64}$/i.test(vault.address) || BigInt(vault.address) === 0n || !strategy.id) throw Error("Invalid Troves vault metadata");
    vaults.push({address: normalizeHex(vault.address), id: strategy.id, name: strategy.name});
  }
  if (!vaults.length || vaults.length > 128) throw Error("Unexpected Troves vault catalogue size");
  return {vaults, excludedStrategyIds};
}
export function vaultStreamKey(chain: string, vaults: Vault[]): string {
  const addresses = [...new Set(vaults.map(v => normalizeHex(v.address)))].sort();
  return `troves:vaults:${chain}:${createHash("sha256").update(addresses.join(",")).digest("hex").slice(0,16)}`;
}

/** A fixed finalized upper bound survives every cursor-resume tick.
 * Empty pages with a next cursor are NOT completion. Overlap one boundary
 * block on catchup; immutable event keys deduplicate the overlap.
 */
export async function syncShadowStream(opts: {
  db: Db; client: Pick<StarkscanClient, "globalEvents">; key: string;
  addresses: string[]; topics: string[]; fromBlock: number; head: number;
  consume: (event: RawContractEvent) => void; maxPages?: number;
}): Promise<StreamState> {
  const {db, client, key, addresses, topics, consume} = opts;
  const state = readState<StreamState>(db, key) ?? {
    coveredBlock: null, fromBlock: opts.fromBlock, targetBlock: null, cursor: null, completedAt: null,
  };
  if (state.targetBlock == null) {
    state.fromBlock = Math.max(opts.fromBlock, state.coveredBlock ?? opts.fromBlock);
    state.targetBlock = opts.head;
    state.cursor = null;
  }
  if (state.targetBlock < state.fromBlock) throw Error("Shadow index finalized head moved backwards");
  const allowed = new Set(addresses.map(normalizeHex));
  const allowedTopics = new Set(topics.map(normalizeHex));
  for (let pageNumber=0; pageNumber < (opts.maxPages ?? 20); pageNumber++) {
    const page = await client.globalEvents({addresses, topics, fromBlock: state.fromBlock,
      toBlock: state.targetBlock, cursor: state.cursor, limit: 100});
    if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw Error("Invalid Starkscan shadow event page");
    if (page.nextCursor && page.nextCursor === state.cursor) throw Error("Starkscan shadow cursor did not advance");
    db.exec("BEGIN");
    try {
      for (const e of page.items) {
        if (!allowed.has(normalizeHex(e.address)) || e.blockNumber < state.fromBlock || e.blockNumber > state.targetBlock) throw Error("Starkscan shadow event outside requested scope");
        if (allowedTopics.size && !allowedTopics.has(normalizeHex(e.topic0))) throw Error("Starkscan shadow event outside requested topics");
        consume(e);
      }
      state.cursor = page.nextCursor;
      if (state.cursor === null) {
        state.coveredBlock = state.targetBlock;
        state.targetBlock = null;
        state.completedAt = Date.now();
      }
      saveState(db, key, state);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    if (state.targetBlock === null) break;
  }
  return state;
}
export function recordShadowAccount(db: Db, chain: string, e: RawContractEvent): void {
  if (normalizeHex(e.topic0) !== SHADOW_DEPLOYED || !e.topic2) throw Error("Invalid shadow deployment event");
  const account = normalizeHex(e.topic2);
  if (BigInt(account) === 0n) throw Error("Invalid zero shadow account");
  db.prepare(`INSERT INTO shadow_accounts(chain,address,deployed_block,tx_hash) VALUES(?,?,?,?)
    ON CONFLICT(chain,address) DO UPDATE SET deployed_block=MIN(deployed_block,excluded.deployed_block)`)
    .run(chain, account, e.blockNumber, e.txHash);
}
/** Prefer the position owner, never an arbitrary address somewhere in calldata.
 * Claims expose their recipient, and requests expose their share owner.
 * Missing ABI decoding is recorded as incomplete coverage, not a zero.
 */
/** Starkscan marks some legacy Troves component events name_only. These
 * exact layouts were checked against mainnet Cairo ABIs and Troves's public
 * indexer (src/strkfarm/deposits-withdraws.ts). Reject any other shape.
 */
function legacyVaultActivity(e: RawContractEvent): {kind:string;account:string|null} {
  const keys = e.keys ?? [e.topic0,e.topic1,e.topic2,e.topic3].filter((k):k is string=>k!=null);
  const normalized = keys.map(normalizeHex);
  const nested = normalized[0] === selectorOf("ERC4626Event");
  const selector = normalized[nested ? 1 : 0];
  const offset = nested ? 1 : 0;
  let account:string|undefined, kind:string|undefined;
  if (selector === selectorOf("Deposit")) {
    kind="deposit";
    if(keys.length===3+offset && e.data.length===4) account=keys[2+offset];
    else if(!nested && keys.length===1 && e.data.length===6) account=e.data[1];
    // YOLO: user is keyed; receiver owns the minted shares.
    else if(!nested && keys.length===2 && e.data.length===5) account=e.data[0];
  } else if(selector === selectorOf("Withdraw")) {
    kind="withdraw";
    if(keys.length===4+offset && e.data.length===4) account=keys[3+offset];
    else if(!nested && keys.length===1 && e.data.length===7) account=e.data[2];
  } else if(!nested && selector===selectorOf("RedeemRequested") && keys.length===1 && e.data.length===10) {
    kind="withdraw_request"; account=e.data[0];
  } else if(!nested && selector===selectorOf("RedeemClaimed") && keys.length===1 && e.data.length===9) {
    kind="withdraw_claim"; account=e.data[0];
  } else if(!nested && selector===selectorOf("Redeem") && keys.length===2 && e.data.length===9) {
    kind="withdraw"; account=keys[1];
  }
  return kind && account && /^0x[0-9a-f]{1,64}$/i.test(account)
    ? {kind,account:normalizeHex(account)} : {kind:"undecoded",account:null};
}
export function decodeVaultActivity(e: RawContractEvent): {kind: string; account: string | null} {
  if (!Array.isArray(e.decodedFields)) return legacyVaultActivity(e);
  const kind = e.eventName ? KINDS[e.eventName] : undefined;
  if (!kind) return {kind:"undecoded",account:null};
  const names = kind === "deposit" ? ["owner", "receiver", "user"]
    : kind === "withdraw_claim" ? ["receiver", "owner", "user"] : ["owner", "user", "sender"];
  for (const name of names) {
    const field = e.decodedFields.find(f => f.label === name);
    if (field) {
      if (field.status !== "decoded" || !field.addressValue || !/^0x[0-9a-f]{1,64}$/i.test(field.addressValue)) break;
      return {kind, account: normalizeHex(field.addressValue)};
    }
  }
  return {kind: "undecoded", account: null};
}
export function recordVaultActivity(db: Db, chain: string, e: RawContractEvent): void {
  const {kind,account} = decodeVaultActivity(e);
  db.prepare(`INSERT INTO shadow_vault_events(chain,vault,block_number,tx_index,log_index,tx_hash,timestamp_iso,kind,account)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,vault,block_number,tx_index,log_index) DO UPDATE SET kind=excluded.kind,account=excluded.account`)
    .run(chain, normalizeHex(e.address), e.blockNumber, e.txIndex, e.logIndex, normalizeHex(e.txHash), e.timestampIso, kind, account);
}

export async function syncTrovesShadow(opts: {
  db: Db; client: Pick<StarkscanClient,"status"|"globalEvents">; chain: string;
  fetchCatalogue?: () => Promise<unknown>; maxPages?: number;
}): Promise<boolean> {
  const {db,client,chain} = opts;
  if (chain !== "SN_MAIN") return true;
  const catalogueBody = await (opts.fetchCatalogue ?? (async () => {
    const r = await fetch(TROVES_CATALOGUE, {signal: AbortSignal.timeout(15_000)});
    if (!r.ok) throw Error(`Troves catalogue HTTP ${r.status}`);
    return r.json();
  }))();
  const current = parseCatalogue(catalogueBody);
  const previous = readState<Catalogue>(db, CATALOG_KEY(chain));
  // Retain retired vaults so removing a strategy from the UI never erases history.
  const merged = new Map((previous?.vaults ?? []).map(v => [v.address,v]));
  for (const vault of current.vaults) merged.set(vault.address,vault);
  const catalogue = {...current, vaults: [...merged.values()]};
  if (catalogue.vaults.length > 128) throw Error("Troves catalogue exceeds Starkscan batch limit");
  const status = await client.status();
  const head = Math.min(status.finalizedBlockNumber, status.latestIndexedBlockNumber);
  if (!Number.isSafeInteger(head) || head < 0) throw Error("Starkscan finalized head unavailable");
  saveState(db, CATALOG_KEY(chain), catalogue);
  const common = {db, client, head, ...(opts.maxPages == null ? {} : {maxPages: opts.maxPages})};
  const factory = await syncShadowStream({...common, key: FACTORY_KEY(chain),
    addresses:[SHADOW_ANONYMIZER], topics:[SHADOW_DEPLOYED], fromBlock:0,
    consume:e=>recordShadowAccount(db,chain,e)});
  if (factory.targetBlock !== null || factory.coveredBlock === null) return false;
  const first = db.prepare("SELECT MIN(deployed_block) AS first FROM shadow_accounts WHERE chain=?").get(chain) as {first: number|null};
  const vaults = await syncShadowStream({...common, key: vaultStreamKey(chain,catalogue.vaults),
    addresses:catalogue.vaults.map(v=>v.address), topics:TOPICS, fromBlock:first.first ?? head,
    consume:e=>recordVaultActivity(db,chain,e)});
  return vaults.targetBlock === null;
}

export function trovesShadowActivity(db: Db, chain: string, now=Date.now()) {
  const catalogue = readState<Catalogue>(db,CATALOG_KEY(chain));
  const factory = readState<StreamState>(db,FACTORY_KEY(chain));
  const vaults = catalogue ? readState<StreamState>(db,vaultStreamKey(chain,catalogue.vaults)) : null;
  const covered = factory?.coveredBlock != null && vaults?.coveredBlock != null
    ? Math.min(factory.coveredBlock,vaults.coveredBlock) : null;
  const asOf = factory?.completedAt && vaults?.completedAt ? Math.min(factory.completedAt,vaults.completedAt) : null;
  const result = {
    schemaVersion:1, protocol:"troves", scope:"troves-vaults-by-strk20-shadow-accounts", source:"starkscan-finalized-events",
    countingBasis:"vault-position-owner-or-claim-recipient",
    status:"indexing", asOfBlock:covered, lastCompletedAt:asOf == null ? null : new Date(asOf).toISOString(),
    trackedVaultCount:catalogue?.vaults.length ?? 0,
    excludedStrategyIds:catalogue?.excludedStrategyIds ?? [],
    transactionCount:null as number|null, activeShadowAccounts:null as number|null,
    eventCounts:null as Record<string,number>|null,
    days:[] as {date:string; transactions:number; events:Record<string,number>}[],
    undecodedEventCount:0,
  };
  if (!catalogue || covered === null || asOf === null) return result;
  const list = catalogue.vaults.map(v=>v.address);
  const params = list.map(()=>"?").join(",");
  const missed = db.prepare(`SELECT COUNT(*) AS n FROM shadow_vault_events
    WHERE chain=? AND vault IN (${params}) AND block_number<=? AND kind='undecoded'`).get(chain,...list,covered) as {n:number};
  result.undecodedEventCount = Number(missed.n);
  const rows = db.prepare(`SELECT v.tx_hash,v.timestamp_iso,v.kind,v.account FROM shadow_vault_events v
    JOIN shadow_accounts a ON a.chain=v.chain AND a.address=v.account AND a.deployed_block<=v.block_number
    WHERE v.chain=? AND v.vault IN (${params}) AND v.block_number<=? AND v.kind!='undecoded'
    ORDER BY v.block_number,v.tx_index,v.log_index`).all(chain,...list,covered) as {tx_hash:string;timestamp_iso:string;kind:string;account:string}[];
  const txs = new Set<string>(), accounts = new Set<string>();
  const events:Record<string,number> = {deposit:0,withdraw:0,withdraw_request:0,withdraw_claim:0};
  const days = new Map<string,{txs:Set<string>;events:Record<string,number>}>();
  for (const row of rows) {
    txs.add(row.tx_hash); accounts.add(row.account); events[row.kind]=(events[row.kind]??0)+1;
    const date=row.timestamp_iso.slice(0,10), day=days.get(date)??{txs:new Set<string>(),events:{}};
    day.txs.add(row.tx_hash); day.events[row.kind]=(day.events[row.kind]??0)+1; days.set(date,day);
  }
  result.transactionCount=txs.size; result.activeShadowAccounts=accounts.size; result.eventCounts=events;
  result.days=[...days].map(([date,day])=>({date,transactions:day.txs.size,events:day.events}));
  result.status = missed.n>0 ? "partial" : now-asOf>MAX_AGE_MS ? "stale" : "live";
  return result;
}

export function startTrovesShadowSync(opts: {db:Db;client:StarkscanClient;chain:string}):void {
  if (opts.chain!=="SN_MAIN") return;
  let busy=false;
  async function tick() {
    if(busy)return; busy=true;
    try {
      const complete=await syncTrovesShadow(opts);
      const s=trovesShadowActivity(opts.db,opts.chain);
      console.log(`troves-shadow: ${s.status}, ${s.transactionCount??"—"} tx, ${s.trackedVaultCount} vaults`);
      if(!complete)setTimeout(()=>void tick(),1_000);
    }catch(e){console.error("troves-shadow:",(e as Error).message)}finally{busy=false}
  }
  void tick(); setInterval(()=>void tick(),120_000);
}
