import { test } from "node:test";
import assert from "node:assert/strict";
import { openCache } from "../cache/db.js";
import { saveState, vaultStreamKey, type StreamState } from "./troves-shadow.js";
import { measureTrovesTvl } from "./troves-tvl.js";

test("Troves public and private TVL use the same vault share and TVL base", async () => {
  const db = openCache(":memory:");
  try {
    const chain = "SN_MAIN", vault = "0x123", account = "0xabc";
    const catalogue = { vaults: [{ address: vault, id: "one", name: "One" }], excludedStrategyIds: [] };
    const state: StreamState = { coveredBlock: 100, fromBlock: 0, targetBlock: null, cursor: null, completedAt: Date.now() };
    saveState(db, `troves:catalog:${chain}`, catalogue);
    saveState(db, `troves:factory:${chain}`, state);
    saveState(db, vaultStreamKey(chain, catalogue.vaults), state);
    db.prepare("INSERT INTO shadow_accounts(chain,address,deployed_block,tx_hash) VALUES(?,?,?,?)").run(chain, account, 10, "0x1");
    db.prepare(`INSERT INTO shadow_vault_events(chain,vault,block_number,tx_index,log_index,tx_hash,timestamp_iso,kind,account)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(chain, vault, 20, 0, 0, "0x2", "2026-10-27T10:00:00Z", "deposit", account);
    const reads: string[] = [];
    const client = {
      status: async () => ({ finalizedBlockNumber: 100, latestIndexedBlockNumber: 100 }),
      contractRead: async (_vault: string, selector: string, opts: {calldata?: string[]; blockTag?: string}) => {
        reads.push(`${selector}:${opts.calldata?.[0] ?? "supply"}:${opts.blockTag}`);
        return { result: opts.calldata ? ["0x19", "0x0"] : ["0x64", "0x0"] };
      },
    };
    const fetchImpl = async () => Response.json({ status: true, strategies: [
      { contract: [{ name: "Vault", address: vault }], tvlUsd: 1000 },
    ] });
    const result = await measureTrovesTvl({ db, client: client as never, chain, fetchImpl: fetchImpl as typeof fetch });
    assert.equal(result.private, 250);
    assert.equal(result.public, 750);
    assert.equal(result.observedAccounts, 1);
    assert.equal(reads.length, 2);
    assert.ok(reads.every((read) => read.endsWith(":100")));
  } finally { db.close(); }
});
