import { test } from "node:test";
import assert from "node:assert/strict";
import { registerToken, setTokenPrice } from "@strk20/core";
import { openCache, type Db } from "../cache/db.js";
import { insertVenueSwaps } from "./venue-swap-store.js";
import { backfillSwapPrices, type DailyPriceLookup } from "./swap-price-backfill.js";

const CHAIN = "SN_TEST";

let nextToken = 2000;
function freshToken(decimals = 18): string {
  nextToken += 1;
  const address = `0x${(0xabc0000 + nextToken).toString(16)}`;
  registerToken({
    address,
    symbol: `T${nextToken}`,
    name: `Token ${nextToken}`,
    decimals,
    usdApprox: 0,
    coingeckoId: `coin-${nextToken}`,
  });
  return address;
}

function storedUsd(db: Db, txHash: string): { sell: number | null; buy: number | null } {
  const row = db
    .prepare(`SELECT sell_usd, buy_usd FROM venue_swaps WHERE chain=? AND tx_hash=?`)
    .get(CHAIN, txHash) as { sell_usd: number | null; buy_usd: number | null };
  return { sell: row.sell_usd, buy: row.buy_usd };
}

test("fills a legacy row's USD from the price on the day it traded", async () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  // Recorded before the fix: no price known at insert, so no frozen USD.
  insertVenueSwaps(db, CHAIN, "0xold", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 400n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);
  assert.equal(storedUsd(db, "0xold").sell, null, "precondition: nothing frozen yet");

  // Today's price is 0.5; on the trade day it was 0.25.
  setTokenPrice(token, 0.5);
  const history: DailyPriceLookup = async (coingeckoId) =>
    coingeckoId === `coin-${nextToken}` ? { "2026-07-01": 0.25 } : null;

  const filled = await backfillSwapPrices({ db, chain: CHAIN, history });

  assert.equal(filled, 1);
  assert.equal(storedUsd(db, "0xold").sell, 100);
});

test("leaves rows that already carry a trade-time value untouched", async () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  setTokenPrice(token, 3);
  insertVenueSwaps(db, CHAIN, "0xnew", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 10n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);
  assert.equal(storedUsd(db, "0xnew").sell, 30, "precondition: frozen at insert");

  const history: DailyPriceLookup = async () => ({ "2026-07-01": 999 });
  const filled = await backfillSwapPrices({ db, chain: CHAIN, history });

  assert.equal(filled, 0);
  assert.equal(storedUsd(db, "0xnew").sell, 30);
});

test("leaves a row alone when the day has no historical price", async () => {
  const db = openCache(":memory:");
  const token = freshToken(18);

  insertVenueSwaps(db, CHAIN, "0xgap", "2026-07-01", [
    {
      venue: "avnu",
      sellToken: token,
      sellAmount: 10n * 10n ** 18n,
      buyToken: null,
      buyAmount: null,
    },
  ]);

  const history: DailyPriceLookup = async () => ({ "2026-06-01": 5 });
  const filled = await backfillSwapPrices({ db, chain: CHAIN, history });

  assert.equal(filled, 0);
  assert.equal(storedUsd(db, "0xgap").sell, null);
});
