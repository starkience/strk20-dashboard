import { test } from "node:test";
import assert from "node:assert/strict";
import { registerToken, setTokenPrice } from "@strk20/core";
import { openCache } from "../cache/db.js";
import { insertVenueSwaps } from "../services/venue-swap-store.js";
import { verifiedSwapsByTx } from "./venue-swaps.js";

const CHAIN = "SN_TEST";

let nextToken = 1000;
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

test("verified swaps carry the USD value from when they were recorded", () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  setTokenPrice(token, 2);
  insertVenueSwaps(db, CHAIN, "0xtx1", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 50n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);

  setTokenPrice(token, 10);

  const byTx = verifiedSwapsByTx(db, CHAIN);
  assert.equal(byTx.get("0xtx1")?.usd, 100);
});

test("a swap recorded before its token was priced falls back to the live price", () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  // Price feed hasn't reached this token yet — nothing to freeze.
  insertVenueSwaps(db, CHAIN, "0xtx2", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 3n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);

  setTokenPrice(token, 7);

  const byTx = verifiedSwapsByTx(db, CHAIN);
  assert.equal(byTx.get("0xtx2")?.usd, 21);
});

test("an unpriced sell leg is valued from the buy leg's recorded USD", () => {
  const db = openCache(":memory:");
  const unpriced = freshToken(18);
  const priced = freshToken(6);

  setTokenPrice(priced, 1);
  insertVenueSwaps(db, CHAIN, "0xtx3", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: unpriced,
      sellAmount: 1n * 10n ** 18n,
      buyToken: priced,
      buyAmount: 250n * 10n ** 6n,
    },
  ]);

  setTokenPrice(priced, 4);

  const byTx = verifiedSwapsByTx(db, CHAIN);
  assert.equal(byTx.get("0xtx3")?.usd, 250);
});
