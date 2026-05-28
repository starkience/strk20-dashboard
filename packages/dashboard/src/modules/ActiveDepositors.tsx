import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface ActiveDepositorsData {
  count: number;
}

export interface ActiveDepositorsProps {
  data?: ActiveDepositorsData;
}

export function useActiveDepositorsData(): ActiveDepositorsData | null {
  return useApi<ActiveDepositorsData>("/agg/active-depositors", { pollMs: 15_000 }).data;
}

export function ActiveDepositors({ data: dataProp }: ActiveDepositorsProps = {}) {
  const fetched = useActiveDepositorsData();
  const data = dataProp ?? fetched;
  return (
    <Row
      label="Active depositors (24h)"
      value={data ? data.count.toLocaleString() : "—"}
    />
  );
}
