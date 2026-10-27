import { test } from "node:test";
import assert from "node:assert/strict";
import { selectorOf } from "@strk20/core";
import { SHADOW_ANONYMIZER, SHADOW_DEPLOYED } from "./troves-shadow.js";
import { measureOpusCollateral } from "./opus-collateral.js";

const ABBOT = "0x04d0bb0a4c40012384e7c419e6eb3c637b28e8363fb66958b60d90505b9c072f";
const SHADOW = "0xabc";
const wad = (n: number) => `0x${(BigInt(n) * 10n ** 18n).toString(16)}`;

test("Opus collateral values finalized shadow Troves and subtracts from the same Shrine total", async () => {
  const reads: { selector: string; calldata?: string[]; blockTag?: string }[] = [];
  const client = {
    status: async () => ({ finalizedBlockNumber: 100, latestIndexedBlockNumber: 101 }),
    contractEvents: async (address: string) => ({ nextCursor: null, items: address === SHADOW_ANONYMIZER
      ? [{ address, topic0: SHADOW_DEPLOYED, topic1: "0x1", topic2: SHADOW, blockNumber: 10, txIndex: 0, logIndex: 0,
        timestampIso: "2026-10-20T00:00:00Z" }]
      : [
        { address: ABBOT, topic0: selectorOf("TroveOpened"), topic1: SHADOW, topic2: "0x1", blockNumber: 20, txIndex: 0, logIndex: 0 },
        { address: ABBOT, topic0: selectorOf("TroveOpened"), topic1: "0xdef", topic2: "0x2", blockNumber: 21, txIndex: 0, logIndex: 1 },
      ] }),
    contractRead: async (_address: string, selector: string, opts: { calldata?: string[]; blockTag?: string }) => {
      reads.push({ selector, ...opts });
      return { result: opts.calldata ? ["0x0", "0x0", wad(100), wad(50)] : ["0x0", "0x0", wad(1000), wad(500)] };
    },
  };
  const result = await measureOpusCollateral(client as never);
  assert.deepEqual(result, { public: 900, private: 100, publicDebtCash: 450, privateDebtCash: 50,
    shadowTroves: 1, asOfBlock: 100 });
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1]?.calldata, ["0x1"]);
  assert.ok(reads.every((read) => read.blockTag === "100"));
});
