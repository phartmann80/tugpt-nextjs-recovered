# apps/worker/Dockerfile
#
# Multi-stage build for the TuGPT background workers.
#
# This single image runs EITHER the WhatsApp inbound worker OR the draft
# generation worker, depending on the command docker-compose supplies —
# they must run as separate processes (see apps/worker/src/draft-index.ts
# header comment: "do not make the default worker process run both
# WhatsApp and draft generation concurrently").
#
#   docker compose run whatsapp-worker  -> node dist/index.js
#   docker compose run draft-worker     -> node dist/draft-index.js
#
# Build context MUST be the monorepo root (same reasoning as apps/web):
#
#   docker build -f apps/worker/Dockerfile -t tugpt-worker .

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- 1. Prune the monorepo down to what the worker needs ----
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @tugpt/worker --docker

# ---- 2. Install dependencies for the pruned subset ----
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# ---- 3. Build ----
# Building with the `^build` dependency graph (see turbo.json) also builds
# every @tugpt/* package the worker depends on (ai-orchestration,
# ai-providers, database, jobs, observability).
FROM base AS builder
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo build --filter=@tugpt/worker

# ---- 4. Runtime ----
# Unlike apps/web, there is no "standalone" output tracing for a plain
# Node/tsc build, so the runtime image carries the pruned node_modules
# tree plus every built package — larger than ideal, but correct and safe
# to ship without a local Docker daemon to test against. Revisit with a
# leaner file list once this has been validated on the VPS.
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs worker
COPY --from=builder --chown=worker:nodejs /app ./
USER worker
WORKDIR /app/apps/worker

# Overridden by docker-compose.yml `command:` per service
# (whatsapp-worker -> dist/index.js, draft-worker -> dist/draft-index.js).
CMD ["node", "dist/index.js"]
