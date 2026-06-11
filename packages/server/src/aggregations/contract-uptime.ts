import type { Db } from "../cache/db.js";
import { OZ_SELECTORS, normalizeHex } from "@strk20/core";

/**
 * Contract uptime since launch — the honest, on-chain-verifiable kind.
 *
 * The pool is "down" only when its PausableComponent is engaged, which
 * emits OpenZeppelin's Paused / Unpaused events. Launch is the first
 * event the contract ever emitted (its constructor's setup). Uptime is
 * therefore: fraction of time since launch NOT inside a paused
 * interval. As of writing the contract has zero Paused events — a true
 * 100%, no pinning required.
 *
 * (This replaces the earlier heartbeat-based metric, which measured
 * the dashboard indexer's own sync health and once embarrassed us by
 * reporting dev-laptop restarts as "downtime".)
 */

const PAUSED = normalizeHex(OZ_SELECTORS.Paused);
const UNPAUSED = normalizeHex(OZ_SELECTORS.Unpaused);

export interface UptimeDay {
  date: string; // YYYY-MM-DD UTC
  status: "ok" | "paused";
}

export interface ContractUptime {
  launchIso: string;
  days: UptimeDay[];
  /** Percent of time since launch the contract was live (unpaused). */
  pct: number;
  pauseCount: number;
}

export function contractUptime(db: Db, chain: string, pool: string): ContractUptime {
  const first = db
    .prepare(
      `SELECT MIN(timestamp_iso) AS t FROM raw_events WHERE chain=? AND contract=?`
    )
    .get(chain, pool) as { t: string | null };
  if (!first?.t) return { launchIso: "", days: [], pct: 0, pauseCount: 0 };
  const launchMs = Date.parse(first.t);

  // Pause intervals from the Paused/Unpaused event stream.
  const rows = db
    .prepare(
      `SELECT topic0, timestamp_iso FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?)
       ORDER BY timestamp_iso ASC`
    )
    .all(chain, pool, PAUSED, UNPAUSED) as { topic0: string; timestamp_iso: string }[];

  const nowMs = Date.now();
  const intervals: [number, number][] = [];
  let openSince: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.timestamp_iso);
    if (normalizeHex(r.topic0) === PAUSED) {
      if (openSince === null) openSince = t;
    } else if (openSince !== null) {
      intervals.push([openSince, t]);
      openSince = null;
    }
  }
  if (openSince !== null) intervals.push([openSince, nowMs]); // still paused

  const pausedMs = intervals.reduce((acc, [a, b]) => acc + (b - a), 0);
  const totalMs = Math.max(1, nowMs - launchMs);
  const pct = (1 - pausedMs / totalMs) * 100;

  // One bar per UTC day since launch; a day is "paused" if any pause
  // interval overlaps it.
  const days: UptimeDay[] = [];
  const day = new Date(launchMs);
  day.setUTCHours(0, 0, 0, 0);
  for (let t = day.getTime(); t <= nowMs; t += 24 * 60 * 60 * 1000) {
    const dayEnd = t + 24 * 60 * 60 * 1000;
    const paused = intervals.some(([a, b]) => a < dayEnd && b > t);
    days.push({
      date: new Date(t).toISOString().slice(0, 10),
      status: paused ? "paused" : "ok",
    });
  }

  return {
    launchIso: first.t,
    days,
    pct,
    pauseCount: intervals.length,
  };
}
