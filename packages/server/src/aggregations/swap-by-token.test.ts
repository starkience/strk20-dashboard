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
  assert.equal(result.totalsByVenue.avnu, 100);
});

test("counts Ekubo ZEC/USDC in both directions from the stablecoin leg", () => {
  const db = openCache(":memory:");
  const zec = freshToken(8);
  const usdc = freshToken(6);
  registerToken({
    address: zec,
    symbol: "ZEC",
    name: "Zcash",
    decimals: 8,
    usdApprox: 150,
    coingeckoId: null,
  });
  registerToken({
    address: usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    usdApprox: 1,
    coingeckoId: null,
  });

  const insert = db.prepare(`
    INSERT INTO venue_swaps
      (chain, tx_hash, evt_index, day, venue,
       sell_token, sell_amount, buy_token, buy_amount, sell_usd, buy_usd)
    VALUES (?, ?, 0, '2026-10-01', 'ekubo', ?, ?, ?, ?, ?, ?)
  `);
  // Current ZEC valuation differs intentionally. The stable amount is the
  // deterministic USD notional of each trade.
  insert.run(CHAIN, "0xzec-sell", zec, String(10n ** 8n), usdc, String(90n * 10n ** 6n), 150, 90);
  insert.run(CHAIN, "0xzec-buy", usdc, String(80n * 10n ** 6n), zec, String(10n ** 8n), 80, 150);

  const result = swapVolumeByToken(db, CHAIN, POOL);
  const day = result.days.find((d) => d.date === "2026-10-01");

  assert.equal(result.totalUsd, 170);
  assert.equal(result.totalsByVenue.ekubo, 170);
  assert.equal(result.swapCountByVenue.ekubo, 2);
  assert.equal(day?.byToken.ZEC, 170);
  assert.equal(day?.byVenue.ekubo, 170);
});
