import { useCallback, useEffect, useRef, useState } from "react";
import { ReceiptScene, type ReceiptSceneHandle } from "./modules/ReceiptScene.js";
import {
  ReceiptFooter,
  ReceiptHistory,
} from "./modules/ReceiptPagination.js";
import { useReceiptFeed } from "./lib/receipt-feed.js";

const DRAIN_INTERVAL_MS = 1400; // gap between successive print animations

export function Receipts() {
  const { state, drainArrival } = useReceiptFeed({ pollMs: 6_000, limit: 80 });
  const sceneRef = useRef<ReceiptSceneHandle | null>(null);
  const [view, setView] = useState<"live" | "history">("live");

  const onSceneMounted = useCallback((h: ReceiptSceneHandle) => {
    sceneRef.current = h;
  }, []);

  // Drain the arrival queue at a fixed cadence so we don't flood the scene
  // when a poll surfaces ten receipts at once.
  useEffect(() => {
    if (view !== "live") return;
    const id = window.setInterval(() => {
      if (!sceneRef.current) return;
      const r = drainArrival();
      if (r) sceneRef.current.enqueue(r);
    }, DRAIN_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [view, drainArrival]);

  // Seed the grid on first load — no animation, receipts just appear in
  // their final positions. Only later arrivals print in with the 3D animation.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (state.history.length === 0) return;
    if (!sceneRef.current) return;
    seededRef.current = true;
    sceneRef.current.placeImmediate(state.history);
  }, [state.history]);

  return (
    <div data-strk20="receipts">
      <header data-strk20="receipts-header">
        <div className="title-block">
          <h1>STRK20 · Receipts</h1>
          <span className="sub">Live transaction feed · Starknet privacy pool</span>
        </div>
        <span className="status">
          {state.loading && state.history.length === 0
            ? "connecting…"
            : state.error
            ? `error · ${state.error.message}`
            : `${state.history.length} known`}
        </span>
      </header>

      {view === "live" ? (
        <>
          <div data-strk20-scene-wrap>
            <ReceiptScene onMounted={onSceneMounted} />
            <div className="scene-vignette" aria-hidden />
            <div className="scene-printer" aria-hidden>
              <span className="printer-label">PRINTING</span>
            </div>
          </div>
          <ReceiptFooter
            arrivalsPending={state.arrivals.length}
            totalKnown={state.history.length}
            onViewAll={() => setView("history")}
          />
        </>
      ) : (
        <ReceiptHistory history={state.history} onClose={() => setView("live")} />
      )}
    </div>
  );
}
