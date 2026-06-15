import type { Db } from "../cache/db.js";
import { lookupToken, applyDecimals, normalizeHex } from "@strk20/core";

/**
 * Private swap volume, per token, daily — the "Private AVNU Swap Volume"
 * chart. Each verified AVNU venue swap is valued on its sell leg (the token
 * routed out), falling back to the buy leg, and attributed to that priced
 * token. AVNU is the only live private-swap venue (ekubo/vesu/etc. are
 * coming soon), so this is AVNU-specific by design.
 */

const VENUE = "avnu";

export interface SwapByTokenDay {
  date: string; // YYYY-MM-DD (UTC)
  total: number; // USD == sum of byToken
  /** token symbol → USD swapped that day. */
  byToken: Record<string, number>;
}

export interface SwapByToken {
  days: SwapByTokenDay[];
  tokens: string[]; // by overall volume desc — stack + legend order
  totalUsd: number;
  swapCount: number;
}

export function swapVolumeByToken(db: Db, chain: string, _pool: string): SwapByToken {
  const rows = db
    .prepare(
      `SELECT day, sell_token, sell_amount, buy_token, buy_amount
       FROM venue_swaps WHERE chain=? AND venue=?`
    )
    .all(chain, VENUE) as {
    day: string | null;
    sell_token: string | null;
    sell_amount: string | null;
    buy_token: string | null;
    buy_amount: string | null;
  }[];

  const legUsd = (token: string | null, amount: string | null): number | null => {
    if (!token || !amount) return null;
    const meta = lookupToken(normalizeHex(token));
    if (!meta || meta.usdApprox <= 0) return null;
    try {
      return applyDecimals(BigInt(amount), meta.decimals) * meta.usdApprox;
    } catch {
      return null;
    }
  };
  const symbolOf = (token: string | null): string | null => {
    if (!token) return null;
    const m = lookupToken(normalizeHex(token));
    return m?.symbol || shortAddr(token);
  };

  const byDay = new Map<string, Map<string, number>>();
  let totalUsd = 0;
  let swapCount = 0;
  for (const r of rows) {
    swapCount += 1;
    if (!r.day) continue;
    // Value on the sell leg, fall back to the buy leg; attribute to whichever
    // priced side we used.
    let usd = legUsd(r.sell_token, r.sell_amount);
    let sym = symbolOf(r.sell_token);
    if (usd == null) {
      usd = legUsd(r.buy_token, r.buy_amount);
      sym = symbolOf(r.buy_token);
    }
    if (usd == null || usd <= 0 || !sym) continue;
    let m = byDay.get(r.day);
    if (!m) { m = new Map(); byDay.set(r.day, m); }
    m.set(sym, (m.get(sym) ?? 0) + usd);
    totalUsd += usd;
  }

  if (byDay.size === 0) return { days: [], tokens: [], totalUsd: 0, swapCount };

  const sorted = [...byDay.keys()].sort();
  const today = new Date().toISOString().slice(0, 10);
  const days: SwapByTokenDay[] = [];
  for (let cur = sorted[0]!; cur <= today; cur = nextDay(cur)) {
    const m = byDay.get(cur);
    const byToken: Record<string, number> = {};
    let total = 0;
    if (m) for (const [s, u] of m) { byToken[s] = u; total += u; }
    days.push({ date: cur, total, byToken });
  }

  const tot = new Map<string, number>();
  for (const d of days) for (const [s, u] of Object.entries(d.byToken)) tot.set(s, (tot.get(s) ?? 0) + u);
  const tokens = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);

  return { days, tokens, totalUsd, swapCount };
}

function shortAddr(address: string): string {
  const s = address.toLowerCase();
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
