# apps/web/Dockerfile
#
# Multi-stage build for the TuGPT web app (Next.js 16, App Router).
#
# Build context MUST be the monorepo root, because this app depends on
# internal workspace packages (@tugpt/*) that live under packages/*:
#
#   docker build -f apps/web/Dockerfile -t tugpt-web .
#
# docker-compose.yml at the repo root is already configured with the
# correct build context, so `docker compose build web` just works.
#
# Uses `turbo prune` (the officially recommended pattern for Turborepo +
# Docker) to produce a minimal subset of the monorepo containing only the
# packages `web` actually depends on, so the install layer stays small and
# cacheable across builds.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- 1. Prune the monorepo down to what `web` needs ----
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune web --docker

# ---- 2. Install dependencies for the pruned subset ----
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# ---- 3. Build ----
FROM base AS builder
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
# NEXT_PUBLIC_* values are baked into the client bundle at build time, so
# they must be real values (not secrets) available at image build time.
# Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, provider keys, etc.) are
# NOT needed at build time and must only be supplied at container runtime
# via env_file (see docker-compose.yml).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
RUN pnpm exec turbo build --filter=web

# ---- 4. Runtime ----
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
# apps/web/public must exist in the checkout or this COPY fails the build.
# Git does not track empty directories, so the directory is held open by
# apps/web/public/.gitkeep. On 2026-08-24 the last three files in it (the
# create-next-app SVGs) were deleted, the directory vanished from a fresh
# clone, and this line failed — a break that `next build` cannot reproduce
# locally, because the developer's working tree still had the empty folder.
# Do not delete .gitkeep.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
