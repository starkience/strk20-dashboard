# @strk20/server — Starkscan-indexing API for the STRK20 dashboard.
#
# Node 24 is required: the cache uses the built-in node:sqlite module.
# tsx runs the TypeScript sources directly (no build step), matching
# how the server runs in development.
FROM node:24-slim

WORKDIR /app

# corepack ships with Node and reads packageManager from package.json
# (pnpm@9), so the container uses the exact pnpm the lockfile expects.
RUN corepack enable

# Manifests first so dependency install caches across code-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json

# --filter @strk20/server... = the server package plus its workspace
# deps (@strk20/core); skips the Vite dashboard package entirely.
RUN pnpm install --frozen-lockfile --filter "@strk20/server..."

COPY packages/core packages/core
COPY packages/server packages/server

# Railway injects PORT; the server honors it (see src/index.ts).
# Persist the event cache by mounting a volume and setting
# CACHE_DB_PATH=/data/cache.db — otherwise every deploy re-backfills
# the full event history from Starkscan.
EXPOSE 8787

WORKDIR /app/packages/server
CMD ["pnpm", "run", "start:prod"]
