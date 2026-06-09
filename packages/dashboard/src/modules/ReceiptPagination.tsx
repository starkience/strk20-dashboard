import { useMemo, useState } from "react";
import type { Receipt } from "../lib/receipt-feed.js";
import { formatTimestamp, shortHash } from "./receipt-format.js";

const PAGE_SIZE = 24;

interface Props {
  history: Receipt[];
  onClose: () => void;
}

/** Flat paginated grid of every receipt the feed has seen. */
export function ReceiptHistory({ history, onClose }: Props) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const slice = useMemo(
    () => history.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [history, page],
  );

  return (
    <div data-strk20-history>
      <div className="history-bar">
        <button type="button" className="back" onClick={onClose}>
          ← Back to live
        </button>
        <span className="count">{history.length} receipts</span>
        <div className="pager">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ←
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          >
            →
          </button>
        </div>
      </div>

      <div className="history-grid">
        {slice.map((r) => (
          <div
            key={r.txHash}
            className={`strk20-receipt history-card kind-row-${r.kind.toLowerCase()}`}
          >
            <div className="receipt-head">
              <span className={`kind kind-${r.kind.toLowerCase()}`}>
                {r.kind === "Deposit" ? "→" : "←"} {r.kind}
              </span>
              <span className="ts">{formatTimestamp(r.timestampIso)}</span>
            </div>
            <div className="receipt-amt">
              <span className="num">{r.amount}</span>
              <span className="sym">{r.tokenSymbol}</span>
            </div>
            <div className="receipt-foot">
              <span className="hash">{shortHash(r.txHash)}</span>
              <span className="peer">
                {r.peer?.label ?? r.peer?.addressShort ?? (r.kind === "Deposit" ? "[private]" : "—")}
              </span>
              <span className="usd">{r.amountUsd != null ? `$${r.amountUsd.toFixed(2)}` : "—"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface FooterProps {
  arrivalsPending: number;
  totalKnown: number;
  onViewAll: () => void;
}

/** Bottom bar shown over the live scene. */
export function ReceiptFooter({ arrivalsPending, totalKnown, onViewAll }: FooterProps) {
  return (
    <div data-strk20-footer>
      <span className="indicator">
        <span className={`dot ${arrivalsPending > 0 ? "active" : ""}`} />
        {arrivalsPending > 0
          ? `${arrivalsPending} printing…`
          : "watching pool"}
      </span>
      <span className="totals">{totalKnown.toLocaleString()} receipts in feed</span>
      <button type="button" className="view-all" onClick={onViewAll}>
        View all receipts →
      </button>
    </div>
  );
}
