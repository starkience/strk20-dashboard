import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface PoolSummary {
  tvlUsd: number;
  depositCount: number;
  withdrawalCount: number;
  userCount: number;
  anonymitySetUnspent: number;
  partial: boolean;
  deposits24h: number;
  withdrawals24h: number;
  tvlChangeUsd24h: number;
}

export interface PoolOverviewProps {
  data?: PoolSummary;
}

export function usePoolOverviewData(): PoolSummary | null {
  return useApi<PoolSummary>("/agg/pool-summary", { pollMs: 15_000 }).data;
}

function fmtUsd(usd: number): string {
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** Pool-level headline numbers, as stacked rows. */
export function PoolOverview({ data: dataProp }: PoolOverviewProps = {}) {
  const fetched = usePoolOverviewData();
  const d = dataProp ?? fetched;
  return (
    <>
      <Row label="TVL" value={d ? fmtUsd(d.tvlUsd) : "—"} />
      <Row label="Deposits" value={d ? d.depositCount.toLocaleString() : "—"} />
      <Row label="Withdrawals" value={d ? d.withdrawalCount.toLocaleString() : "—"} />
      <Row label="All-time depositors" value={d ? d.userCount.toLocaleString() : "—"} />
    </>
  );
}
