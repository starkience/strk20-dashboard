import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";

export interface PrivateOperationsData {
  encNoteCreated: number;
  noteUsed: number;
  total: number;
}

export interface PrivateOperationsProps {
  data?: PrivateOperationsData;
}

export function usePrivateOperationsData(): PrivateOperationsData | null {
  return useApi<PrivateOperationsData>("/agg/private-ops", { pollMs: 10_000 }).data;
}

export function PrivateOperations({ data: dataProp }: PrivateOperationsProps = {}) {
  const fetched = usePrivateOperationsData();
  const data = dataProp ?? fetched;
  return (
    <Row
      label="Private operations (24h)"
      value={data ? data.total.toLocaleString() : "—"}
      context={
        data
          ? `${data.encNoteCreated.toLocaleString()} created · ${data.noteUsed.toLocaleString()} spent`
          : undefined
      }
    />
  );
}
