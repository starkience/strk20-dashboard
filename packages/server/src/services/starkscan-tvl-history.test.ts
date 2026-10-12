import { test } from "node:test";
import assert from "node:assert/strict";
import type { TvlSummary, TokenTvl } from "../aggregations/tvl.js";
import { assembleStarkscanHistory } from "./starkscan-tvl-history.js";

test("Starkscan histories include wrapper assets and share the authoritative live endpoint", () => {
  const token = (symbol: string, balanceHuman: number, balanceUsd: number): TokenTvl => ({
    address: "0x1", symbol, decimals: 6, logoUri: null, coingeckoId: null,
    balanceRaw: String(balanceHuman * 1e6), balanceHuman, balanceUsd,
    depositCount: 1, withdrawalCount: 0, priced: true, identified: true, source: "starkscan",
  });
  const assets = [token("xSTRK", 10, 100), token("SLAY", 20, 200)];
  const tvl: TvlSummary = { totalUsd: 300, tvlSource: "starkscan-finalized",
    tvlAsOf: "2026-10-12T14:00:00Z", tvlAsOfBlock: 123, perToken: assets,
    tokenCount: 2, depositCount: 2, withdrawalCount: 0, unpricedTokenCount: 0,
    priceCoverageComplete: true, partial: false, fetchedAt: 0 };
  const result = assembleStarkscanHistory(tvl, assets, [
    { shieldedSupplySeries: [
      { bucketStartIso: "2026-10-10T00:00:00Z", shieldedSupplyRaw: "5000000" },
      { bucketStartIso: "2026-10-12T00:00:00Z", shieldedSupplyRaw: "9000000" },
    ], privacyFeeSeries: [] },
    { shieldedSupplySeries: [
      { bucketStartIso: "2026-10-10T00:00:00Z", shieldedSupplyRaw: "10000000" },
      { bucketStartIso: "2026-10-11T00:00:00Z", shieldedSupplyRaw: "15000000" },
    ], privacyFeeSeries: [] },
  ]);
  assert.deepEqual(result.days.map((d) => d.total), [150, 200, 300]);
  assert.deepEqual(result.days.at(-1)?.byToken, { xSTRK: 100, SLAY: 200 });
  assert.equal(result.days.at(-1)?.total, tvl.totalUsd);
  assert.equal(result.tvlSource, "starkscan-finalized");
});
