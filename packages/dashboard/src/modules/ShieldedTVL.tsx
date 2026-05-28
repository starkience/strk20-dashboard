import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface ShieldedTVLToken {
  address: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balanceHuman: number;
  balanceUsd: number;
  depositCount: number;
  withdrawalCount: number;
}

export interface ShieldedTVLData {
  totalUsd: number;
  depositCount: number;
  withdrawalCount: number;
  perToken: ShieldedTVLToken[];
  partial: boolean;
}

export interface ShieldedTVLProps {
  data?: ShieldedTVLData;
}

export function useShieldedTVLData(): ShieldedTVLData | null {
  return useApi<ShieldedTVLData>("/agg/tvl", { pollMs: 30_000 }).data;
}

function fmtBalance(v: number): string {
  if (v === 0) return "0";
  if (v < 0.0001) return v.toExponential(2);
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function ShieldedTVL({ data: dataProp }: ShieldedTVLProps = {}) {
  const fetched = useShieldedTVLData();
  const data = dataProp ?? fetched;
  return (
    <div data-strk20-group>
      <div data-strk20-group-label>Shielded TVL · by asset</div>
      {!data && <Row label="loading…" value="—" />}
      {data?.perToken.map((t) => (
        <Row
          key={t.address}
          label={t.symbol}
          context={`↓ ${t.depositCount} · ↑ ${t.withdrawalCount}`}
          value={fmtBalance(t.balanceHuman)}
        />
      ))}
    </div>
  );
}
