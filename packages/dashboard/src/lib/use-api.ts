import { useEffect, useState } from "react";
import { useStrk20 } from "./provider.js";

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Minimal data hook. Polls the API on an interval so the dashboard feels
 * live without a websocket — fine for v1; the SSE live-feed comes in task #6.
 */
export function useApi<T>(path: string, opts: { pollMs?: number } = {}): ApiState<T> {
  const { apiUrl } = useStrk20();
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const url = `${apiUrl}${path}`;

    async function tick() {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = (await res.json()) as T;
        if (!cancelled) setState({ data: json, error: null, loading: false });
      } catch (e) {
        if (!cancelled)
          setState({ data: null, error: e as Error, loading: false });
      }
    }

    tick();
    const id = opts.pollMs ? window.setInterval(tick, opts.pollMs) : null;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
  }, [apiUrl, path, opts.pollMs]);

  return state;
}
