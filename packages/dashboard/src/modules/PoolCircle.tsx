import { usePoolOverviewData, type PoolSummary } from "./PoolOverview.js";

export interface PoolCircleProps {
  data?: PoolSummary;
}

function fmtUsd(usd: number): string {
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function signed(n: number, money = false): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const body = money ? `$${Math.round(abs).toLocaleString("en-US")}` : abs.toLocaleString("en-US");
  return `${sign}${body}`;
}

/**
 * The hero circle for the right pane: TVL in the center, with 24h deltas
 * (TVL change, deposits, withdrawals) beneath it.
 */
export function PoolCircle({ data: dataProp }: PoolCircleProps = {}) {
  const fetched = usePoolOverviewData();
  const d = dataProp ?? fetched;

  return (
    <div data-strk20-circle-wrap>
      <div data-strk20-circle>
        <div className="tvl">{d ? fmtUsd(d.tvlUsd) : "—"}</div>
        <div className="tvl-label">TVL</div>

        <div className="deltas">
          <div className="delta">
            <span className="dv">{d ? signed(d.tvlChangeUsd24h, true) : "—"}</span>
            <span className="dl">TVL · 24h</span>
          </div>
          <div className="delta">
            <span className="dv">{d ? signed(d.deposits24h) : "—"}</span>
            <span className="dl">deposits · 24h</span>
          </div>
          <div className="delta">
            <span className="dv">{d ? signed(d.withdrawals24h) : "—"}</span>
            <span className="dl">withdrawals · 24h</span>
          </div>
        </div>
      </div>
    </div>
  );
}
