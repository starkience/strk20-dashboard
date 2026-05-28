import { PoolOverview } from "./modules/PoolOverview.js";
import { AnonymitySet } from "./modules/AnonymitySet.js";
import { PrivateOperations } from "./modules/PrivateOperations.js";
import { ActiveDepositors } from "./modules/ActiveDepositors.js";
import { NoteAgeHistogram } from "./modules/NoteAgeHistogram.js";
import { ShieldedTVL } from "./modules/ShieldedTVL.js";
import { VisibilityTable } from "./modules/VisibilityTable.js";
import { useApi } from "./lib/use-api.js";

interface ApiHealth {
  cachedEvents: number | null;
  chain?: string;
}

/**
 * Reference composition. Deliberately plain — white, Inter, sharp, every
 * variable on a horizontal row — so the data reads clearly and a host can
 * restyle or cherry-pick individual modules without fighting opinionated CSS.
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

      <PoolOverview />

      <div data-strk20-group>
        <div data-strk20-group-label>Activity</div>
        <AnonymitySet />
        <PrivateOperations />
        <ActiveDepositors />
      </div>

      <ShieldedTVL />
      <NoteAgeHistogram />
      <VisibilityTable />
    </div>
  );
}
