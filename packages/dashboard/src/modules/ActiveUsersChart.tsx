import { useApi } from "../lib/use-api.js";

// Daily Active Users — distinct wallets that shielded (made a Deposit) each UTC
// day, from GET /agg/active-users. A lightweight inline-SVG area chart (no chart
// dependency). Engagement counterpart to the registrations growth curve.

export interface ActiveUsersDay {
  date: string; // YYYY-MM-DD (UTC)
  activeUsers: number;
}
export interface ActiveUsersData {
  days: ActiveUsersDay[];
  total: number;
}

export function useActiveUsersData(): ActiveUsersData | null {
  return useApi<ActiveUsersData>("/agg/active-users", { pollMs: 30_000 }).data;
}

const W = 720;
const H = 240;
const PAD = { l: 36, r: 14, t: 18, b: 26 };
const ORANGE = "#F26419"; // ember orange (STRK20 palette)

export function ActiveUsersChart({ data: dataProp }: { data?: ActiveUsersData } = {}) {
  const fetched = useActiveUsersData();
  const data = dataProp ?? fetched;

  const days = data?.days ?? [];
  const max = Math.max(1, ...days.map((d) => d.activeUsers));
  const peak = days.reduce(
    (best, d) => (d.activeUsers > best.activeUsers ? d : best),
    { date: "—", activeUsers: 0 },
  );

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) =>
    PAD.l + (days.length <= 1 ? 0 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;

  const linePts = days.map((d, i) => `${x(i)},${y(d.activeUsers)}`).join(" ");
  const areaPath =
    days.length > 0
      ? `M ${x(0)},${y(0)} L ${days.map((d, i) => `${x(i)},${y(d.activeUsers)}`).join(" L ")} L ${x(days.length - 1)},${y(0)} Z`
      : "";

  // Sparse x labels: first, middle, last.
  const labelIdx = days.length
    ? [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
    : [];

  return (
    <section
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        background: "rgba(255,255,255,0.02)",
        padding: "16px 18px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 13, letterSpacing: ".04em" }}>
            Daily Active Users
          </h3>
          <p style={{ margin: "2px 0 0", fontSize: 11, opacity: 0.55 }}>
            distinct wallets that shielded · UTC
          </p>
        </div>
        <div style={{ textAlign: "right", fontSize: 11, opacity: 0.7 }}>
          <div>
            <strong style={{ fontSize: 16, color: ORANGE }}>
              {data ? data.total.toLocaleString() : "—"}
            </strong>{" "}
            all-time
          </div>
          {peak.activeUsers > 0 && (
            <div style={{ opacity: 0.7 }}>
              peak {peak.activeUsers.toLocaleString()} · {peak.date}
            </div>
          )}
        </div>
      </div>

      {!data ? (
        <p style={{ fontSize: 12, opacity: 0.5, padding: "32px 0" }}>loading…</p>
      ) : days.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.5, padding: "32px 0" }}>
          no deposits indexed yet
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Daily active users over time"
          style={{ display: "block", marginTop: 10 }}
        >
          {/* y gridlines + ticks at 0, half, max */}
          {[0, max / 2, max].map((v, i) => (
            <g key={i}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1}
              />
              <text
                x={PAD.l - 6}
                y={y(v) + 3}
                textAnchor="end"
                fontSize={9}
                fill="rgba(255,255,255,0.45)"
              >
                {Math.round(v)}
              </text>
            </g>
          ))}

          <path d={areaPath} fill={ORANGE} fillOpacity={0.14} />
          <polyline
            points={linePts}
            fill="none"
            stroke={ORANGE}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* x labels */}
          {labelIdx.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
              fontSize={9}
              fill="rgba(255,255,255,0.45)"
            >
              {days[i]!.date.slice(5)}
            </text>
          ))}
        </svg>
      )}
    </section>
  );
}
