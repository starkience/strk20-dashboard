/** Public aggregate routes used by Starkscan's own Privacy Pool page. */
export async function fetchStarkscanExplorerJson<T>(path: string): Promise<T> {
  const base = (process.env.STARKSCAN_EXPLORER_BASE_URL ?? "https://starkscan.co").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Starkscan explorer ${response.status}: ${path}`);
  return await response.json() as T;
}
