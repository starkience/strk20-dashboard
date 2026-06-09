export function shortHash(h: string): string {
  if (!h) return "—";
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const ageMs = now - d.getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 10);
}
