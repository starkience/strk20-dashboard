import type { HeartbeatCache } from "../cache/heartbeats.js";

/**
 * Daily uptime summary derived from the indexer's sync heartbeats.
 *
 * Each day's status is:
 *   ok        — >= 95% of heartbeats that day succeeded
 *   degraded  — 50–95% succeeded
 *   incident  — < 50% succeeded
 *   unknown   — no heartbeats recorded (server not running, or pre-launch)
 *
 * The overall percentage weights each day's success rate by the number of
 * heartbeats recorded, so an under-observed day doesn't dominate the
 * aggregate.
 *
 * Drop-in for Kuma later: write a parallel aggregator that calls Kuma's
 * /api/status-page/heartbeat/<slug> endpoint and reshapes into the same
 * UptimeHistory output. The /agg/uptime-history handler picks whichever
 * source is configured.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type UptimeStatus = "ok" | "degraded" | "incident" | "unknown";

export interface UptimeDay {
  /** ISO date string YYYY-MM-DD (UTC). */
  date: string;
  status: UptimeStatus;
  /** Fraction of heartbeats that succeeded, 0..1. */
  successRate: number;
  /** Number of heartbeats recorded for the day. */
  count: number;
}

export interface UptimeHistory {
  days: UptimeDay[];
  /** Heartbeat-weighted success percentage across the whole window. */
  pct: number;
}

export function uptimeHistory(
  heartbeats: HeartbeatCache,
  days: number
): UptimeHistory {
  const safeDays = Math.max(1, Math.min(365, days));
  const now = Date.now();
  const startMs = now - safeDays * DAY_MS;

  const rows = heartbeats.since(startMs);

  // Bucket by UTC date.
  const buckets = new Map<string, { ok: number; total: number }>();
  for (const r of rows) {
    const key = new Date(r.ts).toISOString().slice(0, 10);
    const b = buckets.get(key) ?? { ok: 0, total: 0 };
    b.total++;
    if (r.ok === 1) b.ok++;
    buckets.set(key, b);
  }

  // Fill every day in the window (oldest → newest), inserting 'unknown'
  // where the bucket is empty.
  const result: UptimeDay[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    const b = buckets.get(key);
    let status: UptimeStatus = "unknown";
    let successRate = 0;
    let count = 0;
    if (b && b.total > 0) {
      count = b.total;
      successRate = b.ok / b.total;
      if (successRate >= 0.95) status = "ok";
      else if (successRate >= 0.5) status = "degraded";
      else status = "incident";
    }
    result.push({ date: key, status, successRate, count });
  }

  // Weighted overall percentage (skip days with no observations).
  let totalScore = 0;
  let totalWeight = 0;
  for (const d of result) {
    if (d.count > 0) {
      totalScore += d.successRate * d.count;
      totalWeight += d.count;
    }
  }
  const pct = totalWeight > 0 ? (totalScore / totalWeight) * 100 : 0;

  return { days: result, pct };
}
