import type { Db } from "../cache/db.js";
import { EVENT_SELECTORS, normalizeHex } from "@strk20/core";
import { verifiedSwapsByTx } from "./venue-swaps.js";
import { classifyRoundTrip } from "./window.js";

/**
 * Private actions by protocol, daily — the COUNT twin of routed-volume. Each
 * in-pool round-trip tx is counted once under the protocol it routed through:
 *   - swap → the verified venue (avnu / ekubo)
 *   - lend → vesu
 * Stakes (endur) are out of scope for this chart (matches the reference's
 * avnu/ekubo/vesu legend). Unlike DeFi Volume (AVNU-only by $), all three
 * count protocols are shown here.
 */

export interface ActionsByProtocolDay {
  date: string; // YYYY-MM-DD (UTC)
  total: number; // count == sum of byProtocol
  byProtocol: Record<string, number>;
}

export interface ActionsByProtocol {
  days: ActionsByProtocolDay[];
  protocols: string[];
}

const LEND_PROTOCOL = "vesu";
const BASE_PROTOCOLS = ["avnu", "ekubo", "vesu"];

export function actionsByProtocol(db: Db, chain: string, pool: string): ActionsByProtocol {
  const rows = db
    .prepare(
      `SELECT substr(timestamp_iso, 1, 10) AS day, tx_hash, topic0, topic2
       FROM raw_events
       WHERE chain=? AND contract=? AND topic0 IN (?, ?, ?)
       ORDER BY timestamp_iso ASC`
    )
    .all(
      chain,
      pool,
      EVENT_SELECTORS.Deposit,
      EVENT_SELECTORS.OpenNoteDeposited,
      EVENT_SELECTORS.Withdrawal
    ) as { day: string; tx_hash: string; topic0: string; topic2: string | null }[];

  const WD = normalizeHex(EVENT_SELECTORS.Withdrawal);
  interface TxAcc { day: string; outs: Set<string>; ins: Set<string>; }
  const byTx = new Map<string, TxAcc>();
  for (const r of rows) {
    if (!r.topic2) continue;
    let e = byTx.get(r.tx_hash);
    if (!e) { e = { day: r.day, outs: new Set(), ins: new Set() }; byTx.set(r.tx_hash, e); }
    const tok = normalizeHex(r.topic2);
    if (normalizeHex(r.topic0) === WD) e.outs.add(tok);
    else e.ins.add(tok);
  }

  const verified = verifiedSwapsByTx(db, chain);
  const byDay = new Map<string, Map<string, number>>();
  const inc = (day: string, proto: string) => {
    let m = byDay.get(day);
    if (!m) { m = new Map(); byDay.set(day, m); }
    m.set(proto, (m.get(proto) ?? 0) + 1);
  };

  for (const [tx, e] of byTx) {
    const kind = classifyRoundTrip(e.outs, e.ins);
    if (kind === "lend") inc(e.day, LEND_PROTOCOL);
    else if (kind === "swap") {
      const v = verified.get(tx);
      if (v) inc(e.day, (v.venue || "swap").toLowerCase());
    }
    // stake / null → not counted in this chart
  }

  if (byDay.size === 0) return { days: [], protocols: [...BASE_PROTOCOLS] };

  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: ActionsByProtocolDay[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const m = byDay.get(cur);
    const byProtocol: Record<string, number> = {};
    let total = 0;
    if (m) for (const [p, n] of m) { byProtocol[p] = n; total += n; }
    days.push({ date: cur, total, byProtocol });
  }

  const present = new Set<string>();
  for (const d of days) for (const p of Object.keys(d.byProtocol)) present.add(p);
  const extras = [...present].filter((p) => !BASE_PROTOCOLS.includes(p)).sort();
  const protocols = [...BASE_PROTOCOLS, ...extras];

  return { days, protocols };
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
