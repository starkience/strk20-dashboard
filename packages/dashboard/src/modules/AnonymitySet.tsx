import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface AnonymitySetData {
  created: number;
  used: number;
  unspent: number;
}

export interface AnonymitySetProps {
  data?: AnonymitySetData;
}

export function useAnonymitySetData(): AnonymitySetData | null {
  return useApi<AnonymitySetData>("/agg/anonymity-set", { pollMs: 10_000 }).data;
}

export function AnonymitySet({ data: dataProp }: AnonymitySetProps = {}) {
  const fetched = useAnonymitySetData();
  const data = dataProp ?? fetched;
  return (
    <Row
      label="Anonymity set"
      value={data ? data.unspent.toLocaleString() : "—"}
      context={
        data
          ? `${data.created.toLocaleString()} created · ${data.used.toLocaleString()} spent`
          : undefined
      }
    />
  );
}
