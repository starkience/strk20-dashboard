import { PoolOverview } from "./modules/PoolOverview.js";
import { AnonymitySet } from "./modules/AnonymitySet.js";
import { PrivateOperations } from "./modules/PrivateOperations.js";
import { ActiveDepositors } from "./modules/ActiveDepositors.js";
import { NoteAgeHistogram } from "./modules/NoteAgeHistogram.js";
import { ShieldedTVL } from "./modules/ShieldedTVL.js";
import { ActiveApps } from "./modules/ActiveApps.js";
import { PoolCircle } from "./modules/PoolCircle.js";
import { ActiveUsersChart } from "./modules/ActiveUsersChart.js";
import { useApi } from "./lib/use-api.js";

interface ApiHealth {
  cachedEvents: number | null;
  chain?: string;
}

/**
 * 25 / 75 split. Left rail stacks the metrics (many-variable ones collapse into
 * dropdowns). Right pane is intentionally reserved blank for now.
 */
export function Dashboard() {
  const { data: health } = useApi<ApiHealth>("/health", { pollMs: 15_000 });
  return (
    <div data-strk20="dashboard">
      <header data-strk20="header">
        <h1>STRK20 Privacy Pool</h1>
        <span className="status">
          {health?.chain ?? "SN_MAIN"} · block {health?.cachedEvents?.toLocaleString() ?? "—"}
        </span>
      </header>

      <div data-strk20-split>
        <aside data-strk20-left>
          <PoolOverview />
          <AnonymitySet />
          <ActiveDepositors />
          <PrivateOperations />
          <ShieldedTVL />
          <NoteAgeHistogram />
          <ActiveApps />
        </aside>

        <main data-strk20-right>
          <ActiveUsersChart />
          <PoolCircle />
        </main>
      </div>
    </div>
  );
}
