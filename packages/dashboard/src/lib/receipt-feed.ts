import { useEffect, useRef, useState } from "react";
import { useStrk20 } from "./provider.js";

export type ReceiptKind = "Deposit" | "Withdrawal";

export interface Receipt {
  txHash: string;
  blockNumber: number;
  timestampIso: string;
  kind: ReceiptKind;
  tokenAddress: string;
  tokenSymbol: string;
  amount: string;
  amountUsd: number | null;
  peer: {
    addressShort: string;
    protocolId: string | null;
    label: string | null;
  } | null;
}

export interface ReceiptFeedState {
  history: Receipt[];
  arrivals: Receipt[];
  error: Error | null;
  loading: boolean;
}

/**
 * Polls the recent-transactions endpoint and turns the diff into an ordered
 * arrival queue. `history` is the full known set (newest first), `arrivals`
 * is a FIFO of receipts not yet drained by the renderer.
 */
export function useReceiptFeed(opts: { pollMs?: number; limit?: number } = {}): {
  state: ReceiptFeedState;
  drainArrival: () => Receipt | null;
} {
  const { apiUrl } = useStrk20();
  const pollMs = opts.pollMs ?? 6_000;
  const limit = opts.limit ?? 50;

  const [state, setState] = useState<ReceiptFeedState>({
    history: [],
    arrivals: [],
    error: null,
    loading: true,
  });

  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<Receipt[]>([]);

  useEffect(() => {
    let cancelled = false;
    const url = `${apiUrl}/agg/recent-transactions?limit=${limit}`;

    async function tick() {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as Receipt[] | { transactions: Receipt[] };
        // server wraps in { transactions: [...] }; tolerate either shape.
        const items: Receipt[] = Array.isArray(body) ? body : body.transactions ?? [];
        if (cancelled) return;

        // first load: seed everything as "already seen" so we don't pretend
        // history is brand-new arrivals — only future polls feed the animation.
        if (seenRef.current.size === 0 && items.length > 0) {
          for (const r of items) seenRef.current.add(r.txHash);
          setState({
            history: items,
            arrivals: queueRef.current.slice(),
            error: null,
            loading: false,
          });
          return;
        }

        // newest-first → reverse so the oldest unseen prints first.
        const fresh: Receipt[] = [];
        for (let i = items.length - 1; i >= 0; i--) {
          const r = items[i];
          if (!r) continue;
          if (!seenRef.current.has(r.txHash)) {
            seenRef.current.add(r.txHash);
            fresh.push(r);
          }
        }
        if (fresh.length > 0) queueRef.current.push(...fresh);

        setState({
          history: items,
          arrivals: queueRef.current.slice(),
          error: null,
          loading: false,
        });
      } catch (e) {
        if (!cancelled)
          setState((prev) => ({ ...prev, error: e as Error, loading: false }));
      }
    }

    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiUrl, pollMs, limit]);

  function drainArrival(): Receipt | null {
    const next = queueRef.current.shift() ?? null;
    if (next) {
      setState((prev) => ({ ...prev, arrivals: queueRef.current.slice() }));
    }
    return next;
  }

  return { state, drainArrival };
}
