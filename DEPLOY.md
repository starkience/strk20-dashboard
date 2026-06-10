# Deploying @strk20/server to Railway

The server is a long-running Node 24 process (Starkscan indexer +
aggregation API + SQLite cache). It is NOT serverless-compatible — it
polls Starkscan every 2 minutes and sweeps CoinGecko prices every 12
seconds in the background.

## One-time setup (Railway dashboard, ~5 minutes)

1. **New Project → Deploy from GitHub repo** → pick
   `starkience/strk20-dashboard`. Railway reads `railway.json` and
   builds the root `Dockerfile` automatically.

2. **Variables** (Service → Variables):

   | Variable | Value |
   |---|---|
   | `STARKSCAN_BASE_URL` | `https://preview.188.245.249.37.nip.io/api` |
   | `STARKSCAN_API_KEY` | the `mzk_live_…` key (secret — never commit) |
   | `STARKSCAN_CHAIN` | `SN_MAIN` |
   | `STRK20_POOL_ADDRESS` | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |
   | `CACHE_DB_PATH` | `/data/cache.db` |
   | `API_CORS_ORIGIN` | `*` while testing; lock to the site origin for launch |

   `PORT` is injected by Railway; the server picks it up automatically.

3. **Volume**: Service → Settings → Volumes → mount a 1 GB volume at
   `/data`. Without it the full event history re-backfills from
   Starkscan on every deploy (works, but slow and burns the 60 req/min
   heavy-route budget).

4. **Domain**: Service → Settings → Networking → Generate Domain.
   Copy the `https://….up.railway.app` URL.

5. Verify: `https://<domain>/health` should return
   `{"ok":true,…,"cachedEvents":…}` and the count should climb as the
   backfill walks the history (a few minutes on first boot).

## Point the website at it

In `strk20-website` `index.html`, set the runtime config before the
dashboard scripts load:

```html
<script>window.STRK20_API_BASE = 'https://<domain>'</script>
```

Commit to `latest-2.0`. Every dashboard module reads this global and
falls back to `http://localhost:8787` for local dev.

## Notes

- First boot backfills ~12k events (a few minutes). The dashboard
  serves partial numbers until `backfillComplete`.
- The upstream Starkscan base URL is still their PREVIEW infra (raw IP
  via nip.io, no SLA). Chase a production hostname before campaign
  peak; it's a one-variable swap here when it lands.
- Costs: hobby plan ~$5/mo covers this comfortably (one small service
  + 1 GB volume).
