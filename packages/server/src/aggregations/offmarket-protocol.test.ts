import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOLS, protocolForAddress } from "@strk20/core";

const OUTBOUND =
  "0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092";
const INBOUND =
  "0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb";

test("classifies both OFFMARKET anonymizers", () => {
  assert.equal(protocolForAddress(OUTBOUND), "offmarket");
  assert.equal(protocolForAddress(INBOUND), "offmarket");

  // Starknet APIs do not consistently retain leading address zeroes.
  assert.equal(protocolForAddress(`0x${OUTBOUND.slice(2).replace(/^0+/, "")}`), "offmarket");
  assert.equal(protocolForAddress(`0x${INBOUND.slice(2).replace(/^0+/, "")}`), "offmarket");
});

test("publishes OFFMARKET as a curated router integration", () => {
  const offmarket = PROTOCOLS.find((protocol) => protocol.id === "offmarket");
  assert.ok(offmarket);
  assert.equal(offmarket.label, "OFFMARKET");
  assert.equal(offmarket.integrationType, "router");
  assert.equal(offmarket.needsCuration, false);
  assert.deepEqual(offmarket.addresses, [OUTBOUND, INBOUND]);
});
