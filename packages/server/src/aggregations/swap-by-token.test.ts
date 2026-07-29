import { test } from "node:test";
import assert from "node:assert/strict";
import { registerToken, setTokenPrice } from "@strk20/core";
import { openCache } from "../cache/db.js";
import { insertVenueSwaps } from "../services/venue-swap-store.js";
import { swapVolumeByToken } from "./swap-by-token.js";

const CHAIN = "SN_TEST";
const POOL = "0xpool";

let nextToken = 0;
function freshToken(decimals = 18): string {
  nextToken += 1;
  const address = `0x${(0xabc0000 + nextToken).toString(16)}`;
  registerToken({
    address,
    symbol: `T${nextToken}`,
    name: `Token ${nextToken}`,
    decimals,
    usdApprox: 0,
    coingeckoId: null,
  });
  return address;
}

test("values a swap at the price when it was recorded, not the price today", () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  setTokenPrice(token, 0.1);
  insertVenueSwaps(db, CHAIN, "0xtx1", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 1000n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);

  // Price halves after the swap was recorded.
  setTokenPrice(token, 0.05);

  const result = swapVolumeByToken(db, CHAIN, POOL);
  assert.equal(result.totalUsd, 100);
});
