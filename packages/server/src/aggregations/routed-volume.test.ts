import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EKUBO_SWAP_ANONYMIZER_ADDRESS,
  EVENT_SELECTORS,
  registerToken,
} from "@strk20/core";
import { openCache } from "../cache/db.js";
import { routedVolume } from "./routed-volume.js";

const CHAIN = "SN_TEST";
const POOL = "0xpool";
const OUTBOUND =
  "0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092";
const INBOUND =
  "0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb";
const TOKEN = "0x0ff000001";
const TOKEN_IN = "0x0ff000002";

registerToken({
  address: TOKEN,
  symbol: "USDX",
  name: "Test USD",
  decimals: 6,
  usdApprox: 1,
  coingeckoId: null,
});
registerToken({
  address: TOKEN_IN,
  symbol: "USDY",
  name: "Test USD return",
  decimals: 6,
  usdApprox: 1,
  coingeckoId: null,
});

function insertEvent(
  db: ReturnType<typeof openCache>,
  params: {
    block: number;
    tx: string;
    selector: string;
    caller: string;
    data: string[];
    token?: string;
  },
): void {
  db.prepare(
    `INSERT INTO raw_events
       (chain, contract, block_number, tx_index, log_index, tx_hash,
        timestamp_iso, topic0, topic1, topic2, topic3, data_json)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    CHAIN,
    POOL,
    params.block,
    params.tx,
    "2026-08-31T12:00:00.000Z",
    params.selector,
    params.caller,
    params.token ?? TOKEN,
    JSON.stringify(params.data),
  );
}

test("OFFMARKET volume counts outbound anonymizer withdrawals once", () => {
  const db = openCache(":memory:");

  // $250 leaves the privacy pool to place the private position.
  insertEvent(db, {
    block: 1,
    tx: "0xout",
    selector: EVENT_SELECTORS.Withdrawal,
    caller: OUTBOUND,
    data: ["0x0", "0x0", "0x0", "0xee6b280"],
  });
  // The later $300 return settlement is deliberately not added again.
  insertEvent(db, {
    block: 2,
    tx: "0xin",
    selector: EVENT_SELECTORS.Deposit,
    caller: INBOUND,
    data: ["0x11e1a300"],
  });

  const result = routedVolume(db, CHAIN, POOL);
  const day = result.days.find((d) => d.date === "2026-08-31");

  assert.equal(day?.byProtocol.offmarket, 250);
  assert.equal(day?.total, 250);
  assert.ok(result.protocols.includes("offmarket"));
});

test("Ekubo volume requires its anonymizer and a verified Core swap", () => {
  const db = openCache(":memory:");

  const addRoundTrip = (block: number, tx: string, caller: string): void => {
    insertEvent(db, {
      block,
      tx,
      selector: EVENT_SELECTORS.Withdrawal,
      caller,
      data: ["0x0", "0x0", "0x0", "0xee6b280"], // $250 outbound
    });
    insertEvent(db, {
      block: block + 1,
      tx,
      selector: EVENT_SELECTORS.Deposit,
      caller,
      token: TOKEN_IN,
      data: ["0xee6b280"],
    });
  };

  addRoundTrip(10, "0xekubo-private", EKUBO_SWAP_ANONYMIZER_ADDRESS);
  addRoundTrip(20, "0xekubo-public-route", "0x1234");
  addRoundTrip(30, "0xekubo-unverified", EKUBO_SWAP_ANONYMIZER_ADDRESS);

  const insertVerifiedEkubo = db.prepare(
    `INSERT INTO venue_swaps
       (chain, tx_hash, evt_index, day, venue,
        sell_token, sell_amount, buy_token, buy_amount, sell_usd, buy_usd)
     VALUES (?, ?, 0, ?, 'ekubo', NULL, NULL, NULL, NULL, NULL, NULL)`,
  );
  insertVerifiedEkubo.run(CHAIN, "0xekubo-private", "2026-08-31");
  insertVerifiedEkubo.run(CHAIN, "0xekubo-public-route", "2026-08-31");

  const result = routedVolume(db, CHAIN, POOL);
  const day = result.days.find((d) => d.date === "2026-08-31");

  assert.equal(day?.byProtocol.ekubo, 250);
  assert.equal(day?.total, 250);
});
