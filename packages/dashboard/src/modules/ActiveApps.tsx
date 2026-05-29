import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";
import { Disclosure } from "../lib/Disclosure.js";

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

export interface ActiveAppsProps {
  data?: ProtocolsResponse;
}

export function useActiveAppsData(): ProtocolsResponse | null {
  return useApi<ProtocolsResponse>("/agg/active-protocols", { pollMs: 15_000 }).data;
}

export function ActiveApps({ data: dataProp }: ActiveAppsProps = {}) {
  const fetched = useActiveAppsData();
  const data = dataProp ?? fetched;
  const apps = data?.protocols ?? [];
  const active = apps.filter((a) => a.totalCount > 0).length;

  return (
    <Disclosure label="Apps" summary={data ? `${active}/${apps.length} active` : "—"}>
      {apps.map((a) => (
        <Row
          key={a.id}
          label={a.label}
          value={`↓ ${a.depositCount.toLocaleString()}  ↑ ${a.withdrawalCount.toLocaleString()}`}
        />
      ))}
      <div data-strk20-note>Dependency: each app's anonymizer contract</div>
    </Disclosure>
  );
}
