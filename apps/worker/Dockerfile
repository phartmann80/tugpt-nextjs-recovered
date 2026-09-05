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
# `^build` in turbo.json builds every @tugpt/* package the worker depends on
# before the worker itself. That is now true rather than aspirational: until
# 2026-08-25 none of those packages defined a build script, so `^build`
# resolved to nothing for them, only the worker's own src/ was compiled, and
# the result crash-looped on first boot because it resolved @tugpt/database
# to raw TypeScript. See the comment on whatsapp-worker in
# docker-compose.yml.
FROM base AS builder
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo build --filter=@tugpt/worker

# ---- 4. Runtime ----
# Unlike apps/web, there is no "standalone" output tracing for a plain
# Node/tsc build, so the runtime image carries the pruned node_modules tree
# plus every built package — larger than ideal, but correct.
#
# "Correct and safe to ship without a local Docker daemon to test against" is
# what this comment used to claim, and the image crash-looped the first time
# anyone started it. CI now boots it on every PR
# (.github/scripts/worker-boot-check.sh), so a leaner file list can be tried
# against evidence rather than argued about.
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs worker
COPY --from=builder --chown=worker:nodejs /app ./
USER worker
WORKDIR /app/apps/worker

# Overridden by docker-compose.yml `command:` per service. This default is
# the WhatsApp worker, and it must stay on the same runner as those commands
# — a CMD that disagrees with them is broken only for a bare `docker run`,
# which is exactly the kind of breakage compose hides.
CMD ["node", "dist/index.js"]
