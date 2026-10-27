/** Current Troves TVL held by shadow accounts observed in the finalized vault index.
 * Plain single-token vaults use finalized total_assets and a recent token quote. The
 * strategy catalogue can lag a new deposit even after the shares are minted.
 * Other vaults use Troves' own USD TVL because their assets need a strategy
 * valuation (not just a spot token quote).
 */
import { normalizeHex, selectorOf, type StarkscanClient } from "@strk20/core";
import type { Db } from "../cache/db.js";
import { readState, trovesShadowActivity, vaultTransferStreamKey, type StreamState, type Vault } from "./troves-shadow.js";

const CATALOGUE_URL = "https://app.troves.fi/api/strategies";
const REFRESH_MS = 120_000;
const STALE_MS = 10 * 60_000;
const PRICE_STALE_MS = 10 * 60_000;
const DIRECT_PRICED_SYMBOLS = new Set(["USDC", "USDC.E", "USDT", "ETH", "WBTC", "STRK"]);
type Reader = Pick<StarkscanClient, "status" | "contractRead">;
type Values = { public: number; private: number; observedAccounts: number; trackedVaults: number; asOfBlock: number };

function uint256(result: string[]): bigint {
  if (!Array.isArray(result) || result.length !== 2) throw Error("Invalid Troves share read");
  const [low, high] = result.map((s) => BigInt(s));
  if (low! < 0n || high! < 0n || low! >= 1n << 128n || high! >= 1n << 128n) throw Error("Invalid Troves share amount");
  return low! + (high! << 128n);
}

export async function measureTrovesTvl(opts: { db: Db; client: Reader; chain: string; fetchImpl?: typeof fetch }): Promise<Values> {
  const activity = trovesShadowActivity(opts.db, opts.chain);
  if (activity.status !== "live" || activity.asOfBlock == null) throw Error(`Troves shadow history is ${activity.status}`);
  const stored = readState<{ vaults: Vault[] }>(opts.db, `troves:catalog:${opts.chain}`);
  if (!stored?.vaults.length) throw Error("Troves vault catalogue unavailable");
  const transfers = readState<StreamState>(opts.db, vaultTransferStreamKey(opts.chain, stored.vaults));
  if (transfers?.coveredBlock == null || transfers.coveredBlock < activity.asOfBlock
      || transfers.targetBlock !== null || transfers.completedAt == null
      || Date.now() - transfers.completedAt > STALE_MS) throw Error("Troves share-transfer history incomplete or stale");
  const response = await (opts.fetchImpl ?? fetch)(CATALOGUE_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`Troves catalogue HTTP ${response.status}`);
  const body = await response.json() as { status?: boolean; strategies?: {
    contract?: { name: string; address: string }[]; tvlUsd?: number;
    depositToken?: { symbol: string; address: string; decimals: number }[];
  }[] };
  if (body.status !== true || !Array.isArray(body.strategies)) throw Error("Invalid Troves catalogue");
  const tvl = new Map<string, number>();
  const directVaults: {vault: string; token: string; decimals: number}[] = [];
  for (const strategy of body.strategies) {
    const vault = strategy.contract?.find((c) => c.name === "Vault");
    if (!vault) continue;
    const address = normalizeHex(vault.address);
    if (tvl.has(address) || typeof strategy.tvlUsd !== "number" || !Number.isFinite(strategy.tvlUsd) || strategy.tvlUsd < 0) {
      throw Error("Invalid Troves vault TVL");
    }
    tvl.set(address, strategy.tvlUsd);
    const tokens = strategy.depositToken;
    if (tokens?.length === 1 && DIRECT_PRICED_SYMBOLS.has(tokens[0]!.symbol?.toUpperCase())) {
      const token = tokens[0]!;
      if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) throw Error("Invalid Troves deposit-token decimals");
      directVaults.push({vault: address, token: normalizeHex(token.address), decimals: token.decimals});
    }
  }
  const allowed = new Set(stored.vaults.map((v) => normalizeHex(v.address)));
  if (!allowed.size || [...allowed].some((address) => !tvl.has(address))) throw Error("Troves catalogue does not cover indexed vaults");
  const holders = opts.db.prepare(`SELECT DISTINCT v.vault, v.account FROM shadow_vault_events v
    JOIN shadow_accounts a ON a.chain=v.chain AND a.address=v.account
    WHERE v.chain=? AND v.block_number<=? AND v.kind!='undecoded' AND v.account IS NOT NULL`).all(opts.chain, activity.asOfBlock) as {vault:string;account:string}[];
  if (holders.some((row) => !allowed.has(normalizeHex(row.vault)))) throw Error("Shadow position outside Troves catalogue");
  const status = await opts.client.status();
  const head = Math.min(status.finalizedBlockNumber, status.latestIndexedBlockNumber);
  if (!Number.isSafeInteger(head) || head < activity.asOfBlock) throw Error("Troves finalized share snapshot unavailable");
  const blockTag = String(head);
  // A catalogue TVL and an onchain share supply from different moments make
  // a fresh deposit appear worth less until Troves' API refreshes. For the
  // plain one-asset vaults, value finalized assets directly instead.
  for (const {vault, token, decimals} of directVaults) {
    if (!allowed.has(vault)) continue;
    const price = opts.db.prepare("SELECT usd,updated_at FROM token_prices WHERE address=?")
      .get(token) as {usd:number;updated_at:number}|undefined;
    if (!price || !Number.isFinite(price.usd) || price.usd <= 0 || Date.now() - price.updated_at > PRICE_STALE_MS) {
      throw Error("Troves deposit-token quote unavailable");
    }
    const assets = uint256((await opts.client.contractRead(vault, selectorOf("total_assets"), { blockTag })).result);
    const usd = Number(assets) / 10 ** decimals * price.usd;
    if (!Number.isFinite(usd) || usd < 0) throw Error("Invalid Troves onchain asset TVL");
    tvl.set(vault, usd);
  }
  const total = [...allowed].reduce((sum, address) => sum + tvl.get(address)!, 0);
  const grouped = new Map<string, Set<string>>();
  for (const row of holders) {
    const vault = normalizeHex(row.vault);
    if (!grouped.has(vault)) grouped.set(vault, new Set());
    grouped.get(vault)!.add(normalizeHex(row.account));
  }
  let privateUsd = 0;
  for (const [vault, accounts] of grouped) {
    const supply = uint256((await opts.client.contractRead(vault, selectorOf("total_supply"), { blockTag })).result);
    if (supply === 0n) {
      if (tvl.get(vault)! > 0) throw Error("Troves vault has TVL without shares");
      continue;
    }
    let owned = 0n;
    for (const account of accounts) {
      owned += uint256((await opts.client.contractRead(vault, selectorOf("balance_of"), { calldata: [account], blockTag })).result);
    }
    if (owned > supply) throw Error("Shadow shares exceed Troves vault supply");
    privateUsd += Number(owned) / Number(supply) * tvl.get(vault)!;
  }
  if (!Number.isFinite(privateUsd) || privateUsd > total + 0.01) throw Error("Invalid shadow Troves TVL");
  return { public: Math.max(0, total - privateUsd), private: privateUsd,
    observedAccounts: new Set(holders.map((h) => normalizeHex(h.account))).size,
    trackedVaults: allowed.size, asOfBlock: head };
}

export function createTrovesTvlService(opts: { db: Db; client: Reader; chain: string; fetchImpl?: typeof fetch; now?: () => number }) {
  const now = opts.now ?? Date.now;
  let current: { value: Values; updatedAt: number } | null = null;
  let failed = false, busy = false;
  async function refresh() {
    if (busy || opts.chain !== "SN_MAIN") return;
    busy = true;
    try { current = { value: await measureTrovesTvl(opts), updatedAt: now() }; failed = false; }
    catch (error) { failed = true; console.error("troves-tvl:", error); }
    finally { busy = false; }
  }
  function snapshot() {
    const live = current != null && now() - current.updatedAt <= STALE_MS;
    return { schemaVersion: 1, protocol: "troves", scope: "observed-strk20-shadow-vault-shares",
      status: live ? "live" : current ? "stale" : failed ? "unavailable" : "indexing",
      unit: "usd", basis: "Troves vault share fraction × vault TVL; observed shadow-account positions",
      public: live ? current!.value.public : null, private: live ? current!.value.private : null,
      observedAccounts: live ? current!.value.observedAccounts : null,
      trackedVaults: live ? current!.value.trackedVaults : null,
      asOfBlock: live ? current!.value.asOfBlock : null,
      asOf: current ? new Date(current.updatedAt).toISOString() : null };
  }
  function start() { if (opts.chain === "SN_MAIN") { void refresh(); setInterval(() => void refresh(), REFRESH_MS); } }
  return { refresh, snapshot, start };
}
