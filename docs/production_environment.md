# TuGPT.ai Production Environment & Security Hardening Guide

This document describes the environment variable configurations, secret handling, and security boundaries required for deploying the TuGPT.ai platform to production.

---

## 1. Production Environment Variables Checklist

Every production environment deployment requires the following variables to be explicitly defined. Do NOT fall back to local development defaults.

| Environment Variable | Source / Value | Security Boundary |
| :---- | :---- | :---- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase Project URL | Publicly accessible in browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production Supabase Anonymous Key | Publicly accessible in browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | Production Supabase Service Role Key | **SECRET**. Server-side only. Must NEVER leak to client-side bundles. |
| `LOGICC_API_KEY` | Production Logicc AI API Key (primary draft provider) | **SECRET**. Server-side only. |
| `LOGICC_ENDPOINT_URL` | Production Logicc Endpoint URL | Server-side only. |
| `LOGICC_DEFAULT_MODEL` | Production Logicc Model Identifier | Server-side only. |
| `LANGDOCK_API_CODE` | Production Langdock Integration API Key (secondary draft provider) | **SECRET**. Server-side only. |
| `LANGDOCK_ENDPOINT_URL` | Production Langdock Endpoint URL | Server-side only. |
| `ANYMIZE_API_KEY` | Production Anymize AI API Key (tertiary fallback provider) | **SECRET**. Server-side only. |
| `ANYMIZE_ENDPOINT_URL` | Production Anymize Endpoint URL (default: https://app.anymize.ai/api/v1/llm) | Server-side only. |
| `ANYMIZE_DEFAULT_MODEL` | Production Anymize Model Identifier (must be set when enabled) | Server-side only. |
| `GATEWAY_API_MASTRA_KEY` | Production Mastra Orchestrator API Key | **SECRET**. Server-side only. |
| `GATEWAY_API_URL` | Production Mastra Endpoint URL | Server-side only. |

---

## 2. Server-Side vs. Client-Side Secret Isolation

To prevent exposing database secrets or service keys:

1. **Prefix Rule**: Only variables prefixed with `NEXT_PUBLIC_` are bundled into browser-side client bundles by Next.js.
2. **Admin Client Restrictions**: The `SUPABASE_SERVICE_ROLE_KEY` is a secret credential bypassing all PostgreSQL RLS policies. It must **never** be defined under client-side execution.
3. **Execution Guard**: `createAdminSupabaseClient` in `@tugpt/database` explicitly asserts `typeof window === 'undefined'` to block instantiation if imported or run inside client bundles.

---

## 3. Production PostgreSQL & Supabase Setup

When deploying database migrations in production:

1. **Migration-Driven**: All structural updates and grants must be driven via migrations (`supabase db push`). No manual SQL client modifications.
2. **Schema Hardening**:
   - Schema `private` holds RLS resolver functions and is inaccessible to the `anon` role.
   - All `public` tables enforce Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`).
3. **Audit Log Immutability**: The `trigger_prevent_audit_log_modification` trigger blocks any user-level attempts to modify or delete logs under `public.audit_logs`.

---

## 4. Worker Runtime

The background workers (draft worker, WhatsApp worker) run via `tsx` (npx tsx) in development, which handles ESM syntax in CJS mode. The worker app (`apps/worker/package.json`) must NOT have `"type": "module"` set, as the 8 internal packages are CommonJS and Node's ESM loader cannot do named imports from CJS modules. This was resolved in PR #10 (Aug 13, 2026). In production (Docker), the workers run their compiled `dist/*.js` output directly with `node`, not `tsx` — see section 5.

---

## 5. VPS Deployment (Docker Compose + systemd)

See ADR-013 for the decision record. This section is the operational runbook.

### 5.1 Server layout

TuGPT runs on a shared VPS (currently `87.106.48.96`, alongside "The Infected"), not Vercel. Expected layout on that host:

```
/opt/tugpt/                  # this repo, checked out at the deployed commit
  docker-compose.yml
  apps/web/Dockerfile
  apps/worker/Dockerfile
/etc/tugpt/
  web.env                    # NEXT_PUBLIC_* + server secrets for the web container, root:root 0600
  worker.env                 # infra + provider secrets for both worker containers, root:root 0600
/etc/systemd/system/
  tugpt.service               # copied from deploy/systemd/tugpt.service
```

`web.env` and `worker.env` are **never** committed to this repo. Populate them from `.env.example` (root) with real production values before first start. `web.env` additionally needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` available as Docker build args (see 5.3) because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle at build time, not at container start.

### 5.2 First-time setup

```bash
# as a user with docker access
git clone <repo> /opt/tugpt
cd /opt/tugpt

mkdir -p /etc/tugpt
chmod 700 /etc/tugpt
# create /etc/tugpt/web.env and /etc/tugpt/worker.env from .env.example,
# filled in with real production values, chmod 600

cp deploy/systemd/tugpt.service /etc/systemd/system/tugpt.service
systemctl daemon-reload
systemctl enable --now tugpt.service
```

### 5.3 Building and deploying a new release

```bash
cd /opt/tugpt
git pull
NEXT_PUBLIC_SUPABASE_URL=<...> \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<...> \
docker compose -p tugpt build
systemctl restart tugpt
docker compose -p tugpt logs -f   # watch startup
```

`systemctl restart tugpt` re-runs `docker compose up -d --build`, so a plain restart picks up an already-built image; run the explicit `build` step above first whenever source changed, so the build args (which are not read from `/etc/tugpt/*.env`) are supplied correctly.

### 5.4 Coexistence with The Infected

Only one process may bind host ports 80/443. TuGPT's `web` service binds `127.0.0.1:3001` only (see `docker-compose.yml`) and expects a shared, host-level reverse proxy (nginx or Caddy — not part of this repo) to route by hostname to that port. **Before the first production deploy**, confirm with whoever owns The Infected's deployment on this host what internal port it uses (or will use, if it is also containerized), so the two don't collide. Track allocated ports here as more apps land on this VPS:

| App | Internal port | Notes |
|---|---|---|
| TuGPT web | 3001 (host, loopback only) → 3000 (container) | this repo |
| The Infected | _unconfirmed_ | currently deployed via Vercel per its own README; VPS port TBD if/when it moves here |

The Docker Compose project name is pinned to `tugpt` (`-p tugpt` / `deploy/systemd/tugpt.service` already passes this) specifically so container and network names can't collide with another app's Compose project on the same host.

### 5.5 Explicitly not part of this deployment work

- Logicc credentials are still pending; `ai_draft_generation` stays `false`. Nothing here changes that.
- `whatsapp_integration` stays `false`. This section covers *where the app runs*, not turning features on.
