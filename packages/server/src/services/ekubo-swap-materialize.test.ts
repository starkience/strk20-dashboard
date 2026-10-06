import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EKUBO_SWAP_ANONYMIZER_ADDRESS,
  EVENT_SELECTORS,
} from "@strk20/core";
import { openCache } from "../cache/db.js";
import { insertVenueSwaps } from "./venue-swap-store.js";
import { materializeEkuboPrivateSwaps } from "./ekubo-swap-materialize.js";

const CHAIN = "SN_TEST";
const POOL = "0xpool";
const ZEC = "0xzec";
const USDC = "0xusdc";

function insertEvent(
  db: ReturnType<typeof openCache>,
  block: number,
  txHash: string,
  selector: string,
  actor: string,
  token: string,
  data: string[],
): void {
  db.prepare(`
    INSERT INTO raw_events
      (chain, contract, block_number, tx_index, log_index, tx_hash,
       timestamp_iso, topic0, topic1, topic2, topic3, data_json)
    VALUES (?, ?, ?, 0, 0, ?, '2026-10-01T12:00:00.000Z', ?, ?, ?, NULL, ?)
  `).run(CHAIN, POOL, block, txHash, selector, actor, token, JSON.stringify(data));
}

test("materializes exact Ekubo input and output legs and ignores other destinations", () => {
  const db = openCache(":memory:");
  insertEvent(
    db, 1, "0xprivate", EVENT_SELECTORS.Withdrawal,
    EKUBO_SWAP_ANONYMIZER_ADDRESS, ZEC,
    ["0x0", "0x0", "0x0", "0x5f5e100"],
  );
  insertEvent(
    db, 2, "0xprivate", EVENT_SELECTORS.OpenNoteDeposited,
    EKUBO_SWAP_ANONYMIZER_ADDRESS, USDC,
    ["0x55d4a80"],
  );
  insertEvent(
    db, 3, "0xpublic", EVENT_SELECTORS.Withdrawal,
    "0x1234", ZEC,
    ["0x0", "0x0", "0x0", "0x5f5e100"],
  );

  assert.equal(materializeEkuboPrivateSwaps(db, CHAIN, POOL), 1);
  const rows = db.prepare(`
    SELECT tx_hash, venue, sell_token, sell_amount, buy_token, buy_amount
    FROM venue_swaps ORDER BY tx_hash
  `).all() as Record<string, unknown>[];

  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    tx_hash: "0xprivate",
    venue: "ekubo",
    sell_token: ZEC,
    sell_amount: "100000000",
    buy_token: USDC,
    buy_amount: "90000000",
  }]);
  assert.equal(materializeEkuboPrivateSwaps(db, CHAIN, POOL), 0, "second pass is idempotent");
});

test("receipt verification cannot erase materialized Ekubo legs", () => {
  const db = openCache(":memory:");
  insertEvent(
    db, 1, "0xprivate", EVENT_SELECTORS.Withdrawal,
    EKUBO_SWAP_ANONYMIZER_ADDRESS, ZEC,
    ["0x0", "0x0", "0x0", "0x5f5e100"],
  );
  insertEvent(
    db, 2, "0xprivate", EVENT_SELECTORS.OpenNoteDeposited,
    EKUBO_SWAP_ANONYMIZER_ADDRESS, USDC,
    ["0x55d4a80"],
  );
  materializeEkuboPrivateSwaps(db, CHAIN, POOL);

  insertVenueSwaps(db, CHAIN, "0xprivate", "2026-10-01", [{
    venue: "ekubo",
    sellToken: null,
    sellAmount: null,
    buyToken: null,
    buyAmount: null,
  }]);

  const row = db.prepare(`
    SELECT sell_token, sell_amount, buy_token, buy_amount
    FROM venue_swaps WHERE tx_hash='0xprivate'
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, {
    sell_token: ZEC,
    sell_amount: "100000000",
    buy_token: USDC,
    buy_amount: "90000000",
  });
});
