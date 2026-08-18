# TuGPT.ai

AI-powered platform built with Next.js 16, React 19, and Supabase. Phase 3A (Secure Inbound WhatsApp Foundation) and Phase 3B (AI Draft Generation) are complete and merged.

## Tech Stack

| Layer | Technology |
|---------|---------|
| Package manager | pnpm 10.34+ |
| Monorepo orchestration | Turborepo |
| Web framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4, Radix UI (shadcn/ui) |
| Language | TypeScript 5.4+ (strict mode) |
| Database & Auth | Supabase (PostgreSQL, RLS, GoTrue) |
| AI providers | Langdock (sole provider, auto model routing — see [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md)) |
| Worker runtime | tsx (ESM syntax in CJS mode, no `"type": "module"`) |
| Testing | Vitest (JS/TS), pgTAP (SQL) |
| Linting | ESLint 9 (flat config) |

## Monorepo Structure

```
tugpt-nextjs-recovered/
├── apps/
│   ├── web/                    # Next.js application
│   └── worker/                 # Background workers (draft, WhatsApp) — run via tsx
├── packages/
│   ├── ai-providers/           # AI provider adapter pattern (active: Langdock; Logicc/Anymize adapters retained, unused)
│   ├── auth/                   # Supabase auth service & session management
│   ├── database/               # Supabase client, migrations, RLS policies
│   ├── feature-flags/          # Feature flag architecture
│   ├── jobs/                   # Background job abstraction
│   ├── observability/          # Structured logger, metrics collector, audit logging
│   ├── security/               # Config validation, secret sanitization
├── supabase/
│   ├── migrations/             # SQL migrations (RLS, triggers, audit tables)
├── docs/
│   ├── adr/                    # Architecture Decision Records (ADR-001 to ADR-014)
│   ├── status/                 # Phase status reports
│   ├── production_environment.md
│   ├── turbo.json
│   ├── pnpm-workspace.yaml
│   └── eslint.config.mjs
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10.34+
- Docker Desktop (for local Supabase)

### Installation

```bash
pnpm install --frozen-lockfile
```

### Environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env.local
```

Required variables:

| Variable | Purpose | Exposure |
|---------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public (browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | Public (browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | **Secret** (server only) |
| `LANGDOCK_API_CODE` | Langdock API key (sole draft provider — see [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md)) | **Secret** (server only) |
| `LANGDOCK_ENDPOINT_URL` | Langdock endpoint (optional, has a default) | Server only |
| `GATEWAY_API_MASTRA_KEY` | Mastra orchestrator API key | **Secret** (server only) |
| `GATEWAY_API_URL` | Mastra endpoint | Server only |
| `IONOS_API_KEY` | IonOS AI Assistant API | **Secret** (server only) |
| `HUBSPOT_API_KEY` | HubSpot CRM API | **Secret** (server only) |

No `LOGICC_*`, `ANYMIZE_*`, or `MODEL` variables are needed: Logicc and Anymize were removed on 2026-08-18 (cost and cross-project isolation, respectively), and Langdock is never pinned to a specific model — it always uses Langdock's `auto` routing. See ADR-006.

See `docs/production_environment.md` for the full security hardening guide.

### Development

```bash
pnpm exec turbo dev
```

### Testing

```bash
# JS/TS tests
pnpm exec turbo test

# Database tests (requires Docker)
pnpm exec supabase db reset
pnpm exec supabase test db
```

### Build & Quality Gates

```bash
pnpm exec turbo build        # Production build
pnpm exec turbo lint          # ESLint (8/8 packages)
pnpm exec turbo typecheck     # TypeScript (8/8 packages)
pnpm exec turbo test          # Vitest
```

All four must pass before merge. The Turbo cache is disabled for `dev` and persisted for `build`.

## CI/CD

The release gate (PR #1, merged) established the following pipeline:

1. `pnpm install --frozen-lockfile`
2. `turbo run lint --force`
3. `turbo run typecheck --force`
4. `turbo run test --force`
5. `turbo run build --force`
6. `supabase db reset` + `supabase test db` (pgTAP)

All checks must pass. No manual SQL modifications to production schema; all changes go through migrations (`supabase db push`).

## Deployment

TuGPT runs on a self-managed VPS via Docker Compose, not Vercel — see
[ADR-013](docs/adr/ADR-013-vps-docker-deployment-target.md) for why, and
[`docs/production_environment.md`](docs/production_environment.md) (section 5)
for the deployment runbook (`docker-compose.yml`, `deploy/systemd/tugpt.service`,
`/etc/tugpt/*.env`).

## Architecture Decision Records

| ADR | Title | Status |
|---------|---------|---------|
| [ADR-001](docs/adr/ADR-001-monorepo-and-package-boundaries.md) | Monorepo and Package Boundaries | Accepted |
| [ADR-002](docs/adr/ADR-002-supabase-authentication-strategy.md) | Supabase Authentication Strategy | Accepted |
| [ADR-003](docs/adr/ADR-003-multi-tenant-organization-model.md) | Multi-Tenant Organization Model | Accepted |
| [ADR-004](docs/adr/ADR-004-rls-and-private-helper-functions.md) | RLS and Private Helper Functions | Accepted |
| [ADR-005](docs/adr/ADR-005-active-organization-context.md) | Active Organization Context | Accepted |
| [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md) | Provider Adapter Architecture | Provisional |
| [ADR-007](docs/adr/ADR-007-background-job-abstraction.md) | Background Job Abstraction | Accepted (amended by ADR-014) |
| [ADR-008](docs/adr/ADR-008-api-versioning-and-authorization.md) | API Versioning and Authorization | Accepted |
| [ADR-009](docs/adr/ADR-009-observability-and-audit-logging.md) | Observability and Audit Logging | Accepted |
| [ADR-010](docs/adr/ADR-010-feature-flag-architecture.md) | Feature Flag Architecture | Accepted |
| [ADR-011](docs/adr/ADR-011-secure-inbound-whatsapp-foundation.md) | Secure Inbound WhatsApp Foundation | Accepted |
| [ADR-012](docs/adr/ADR-012-three-provider-failover-chain.md) | Three-Provider Failover Chain | Superseded by ADR-006 |
| [ADR-013](docs/adr/ADR-013-vps-docker-deployment-target.md) | VPS + Docker Compose Deployment Target (Replacing Vercel) | Accepted |
| [ADR-014](docs/adr/ADR-014-pgmq-production-queue-backend.md) | PGMQ as the Production Queue Backend | Accepted |

## Security

- **Secret isolation**: Only `NEXT_PUBLIC_*` variables are exposed to the browser. `SUPABASE_SERVICE_ROLE_KEY` bypasses all RLS and must never be bundled client-side. `createAdminSupabaseClient` in `@tugpt/database` asserts `typeof window === 'undefined'` to block accidental client usage.
- **Row-Level Security**: All `public` tables enforce RLS (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`). The `private` schema holds RLS resolver functions and is inaccessible to the `anon` role.
- **Audit log immutability**: `trigger_prevent_audit_log_modification` blocks user-level `UPDATE` and `DELETE` on `public.audit_logs`.
- **Structured logging**: `@tugpt/observability` provides a `Logger` generating structured JSON records with automatic secret redaction (Bearer tokens, API keys, Supabase keys) in context values. As of PR #2, `err.message` is also sanitized to prevent secret leakage through error messages.
- **Config validation**: `@tugpt/security` validates environment configuration at startup.

## Current Status

- **Phase 2**: Complete. Release gate passed (lint, typecheck, test, build, pgTAP all green). Merged via PR #1.
- **Phase 3A** (Secure Inbound WhatsApp Foundation): Complete. Merged via commit `4c6551dd` on Aug 5, 2026. Local Docker gate passed: 131 application tests, 133 pgTAP assertions, production build, and typed SQLSTATE transport check all green.
- **Phase 3B** (AI Draft Generation): Complete. Merged via PR #4 (commit `61b7a899`) on Aug 6, 2026, followed by PR #5 (staging readiness) on Aug 7, and PR #7 (three-provider failover chain: Logicc → Langdock → Anymize) on Aug 12. 267 tests passing, lint/typecheck/build green. The draft worker supports a three-provider failover chain with 25-second abort, structured ProviderError classification, and content privacy (sanitized metadata only in logs).
- **PR #2** (Logger Secret Sanitization): Merged (squash) into main at commit `72ba4c2f` on Aug 12, 2026. Applies `sanitizeValue()` to `err.message` in the structured logger, preventing Bearer tokens and API keys in error messages from appearing in plaintext logs.
- **PR #8** (Documentation Update): Merged (squash) into main at commit `e6f2e9e` on Aug 12, 2026. Updated README, ADR-006, ADR-009, and `.env.example` for Phase 3B completion and the three-provider failover chain. Added ADR-012.
- **PR #10** (ESM/CJS Interop Fix): Merged (squash) into main at commit `4a79f02` on Aug 13, 2026. Removed `"type": "module"` from `apps/worker/package.json` to resolve `ERR_REQUIRE_ESM` crash-loop on staging. Internal packages remain CJS; workers execute via `tsx` which handles ESM syntax in CJS mode. Verified on staging: typecheck, lint, test (100/100), build all pass, both workers start cleanly.
- **PR #13** (Docker Compose deployment): Merged into `main` (merge commit `4092f48`) on Aug 18, 2026. Adds `apps/web/Dockerfile`, `apps/worker/Dockerfile`, `docker-compose.yml`, and a `docker-build` CI job, targeting the VPS deployment described below instead of Vercel.
- **PR #14** (Vercel cleanup, VPS runbook, ADR-013): Merged into `main` (merge commit `de1fe63`) on Aug 18, 2026, immediately after PR #13. Removes `vercel.json`, rewrites `docs/production_environment.md` §5 and ADR-013 for the real target (`212.227.44.13`), and adds the systemd-to-Docker-Compose cutover plan and pre-deploy security checklist.
- **Provider simplification** (2026-08-18): TuGPT moved from the three-provider failover chain to Langdock as the sole provider — Logicc cut (cost), Anymize removed (cross-project isolation), model selection set to Langdock's auto routing (never pinned). See [ADR-006](docs/adr/ADR-006-provider-adapter-architecture.md) (rewritten) and [ADR-012](docs/adr/ADR-012-three-provider-failover-chain.md) (superseded). `LogiccAdapter` and `AnymizeAdapter` remain in the repo, unimported by production wiring. Merged into `main` via PR #15 on Aug 18, 2026; `build-and-test` and `docker-build` both green on `main`. Milestone #1 (first end-to-end AI draft in staging) remains gated on the running staging workers' environment being confirmed updated with the live Langdock config, not just the repo.
- **Job-queue backend pinned** (2026-08-18): [ADR-014](docs/adr/ADR-014-pgmq-production-queue-backend.md) documents PGMQ (the Postgres extension, via Supabase) as the confirmed production queue backend for both `whatsapp_inbound` and `draft_generation`, resolving the "BullMQ/Redis or PgBoss" ambiguity left open in [ADR-007](docs/adr/ADR-007-background-job-abstraction.md). Documentation only, no code changes.

## Contributing

1. Create a feature branch from `main`
2. Ensure all quality gates pass: `turbo run lint typecheck test build`
3. Open a PR with a clear description of the change
4. Scope PRs to a single concern
5. Follow existing code conventions (TypeScript strict, ESLint flat config)
6. No new dependencies without justification
