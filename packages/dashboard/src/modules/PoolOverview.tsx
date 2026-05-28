import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface PoolSummary {
  tvlUsd: number;
  depositCount: number;
  withdrawalCount: number;
  userCount: number;
  anonymitySetUnspent: number;
  partial: boolean;
}

export interface ProtocolActivity {
  id: string;
  label: string;
  totalCount: number;
  depositCount: number;
  withdrawalCount: number;
  recentlyActive: boolean;
  needsCuration: boolean;
}

export interface ProtocolsResponse {
  protocols: ProtocolActivity[];
}

export interface PoolOverviewData {
  summary: PoolSummary | null;
  protocols: ProtocolsResponse | null;
}

export interface PoolOverviewProps {
  data?: PoolOverviewData;
}

export function usePoolOverviewData(): PoolOverviewData {
  const summary = useApi<PoolSummary>("/agg/pool-summary", { pollMs: 15_000 }).data;
  const protocols = useApi<ProtocolsResponse>("/agg/active-protocols", {
    pollMs: 15_000,
  }).data;
  return { summary, protocols };
}

function fmtUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

/**
 * The pool at a glance: pool-level numbers on the left, per-app deposit/
 * withdrawal breakdown on the right. Plain boxes, no motion.
 */
export function PoolOverview({ data: dataProp }: PoolOverviewProps = {}) {
  const fetched = usePoolOverviewData();
  const { summary, protocols } = dataProp ?? fetched;
  const apps = protocols?.protocols ?? [];

  return (
    <div data-strk20-card="pool-overview">
      <div data-strk20-overview-grid>
        <section data-strk20-overview-col>
          <div data-strk20-group-label>Pool</div>
          <Row label="TVL" value={summary ? fmtUsd(summary.tvlUsd) : "—"} />
          <Row label="Deposits" value={summary ? summary.depositCount.toLocaleString() : "—"} />
          <Row label="Withdrawals" value={summary ? summary.withdrawalCount.toLocaleString() : "—"} />
          <Row label="Users" value={summary ? summary.userCount.toLocaleString() : "—"} />
          <Row label="Private notes" value={summary ? summary.anonymitySetUnspent.toLocaleString() : "—"} />
        </section>

        <section data-strk20-overview-col>
          <div data-strk20-group-label>Apps · deposits / withdrawals</div>
          <div data-strk20-note>Dependency: each app's anonymizer contract</div>
          {apps.map((a) => (
            <Row
              key={a.id}
              label={a.label}
              value={
                <span data-strk20-app-flows>
                  <span>↓ {a.depositCount.toLocaleString()}</span>
                  <span>↑ {a.withdrawalCount.toLocaleString()}</span>
                </span>
              }
            />
          ))}
        </section>
      </div>
    </div>
  );
}
