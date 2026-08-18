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

TuGPT runs on its own dedicated VPS at **`212.227.44.13`** — not a shared host, not Vercel. This is the same server that already runs `tugpt-whatsapp-worker` and `tugpt-draft-worker` as systemd-native Node processes today. This section describes moving those two services (plus the web app, newly) onto the Docker Compose stack added in PR #13, and retiring the systemd-native workers in the same change — not running both side by side.

### 5.1 Server layout

Current (systemd-native workers, pre-cutover):

```
/opt/tugpt/                        # this repo
/etc/tugpt/
  web.env                          # (new) does not exist yet — web has never run on this server
  worker.env                       # existing — consumed by tugpt-whatsapp-worker / tugpt-draft-worker today
/etc/systemd/system/
  tugpt-whatsapp-worker.service    # existing, runs apps/worker `node dist/index.js` (or tsx) directly on the host
  tugpt-draft-worker.service       # existing, runs apps/worker `node dist/draft-index.js` directly on the host
```

Target (after cutover):

```
/opt/tugpt/                        # this repo, checked out at the deployed commit
  docker-compose.yml
  apps/web/Dockerfile
  apps/worker/Dockerfile
/etc/tugpt/
  web.env                          # NEXT_PUBLIC_* + server secrets for the web container, root:root 0600
  worker.env                       # infra + provider secrets for both worker containers, root:root 0600 (reused as-is)
/etc/systemd/system/
  tugpt.service                    # (new) copied from deploy/systemd/tugpt.service — supervises the whole compose stack
  tugpt-whatsapp-worker.service    # disabled after cutover, kept on disk for rollback
  tugpt-draft-worker.service       # disabled after cutover, kept on disk for rollback
```

`worker.env` already exists on this server and can be reused as-is for the containerized workers — same variable names, same file. `web.env` is new (the web app has never been deployed to this server before) and, in addition to the server secrets, needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` available as Docker build args (see 5.3), because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle at build time, not at container start.

### 5.2 Pre-deploy security checklist

Confirm each of these against the actual state of `212.227.44.13` before proceeding. If confirming any of them requires access this session doesn't have, that needs to be granted (or the check run by whoever already has access) before cutover:

- [ ] SSH key-based auth is enabled and password auth is disabled (`PasswordAuthentication no` in `sshd_config`).
- [ ] `ufw` (or equivalent) allows only 22 (SSH), 80, and 443 inbound; no other ports reachable from the public internet.
- [ ] No application port (`3001` for `web`, or any worker) is bound to `0.0.0.0` — loopback-only, confirmed with `ss -tlnp` after the stack is up.
- [ ] Docker itself isn't punching holes through `ufw` (Docker's default iptables behavior can bypass ufw rules for published ports) — verify with `iptables -L DOCKER-USER` or by testing from outside the host that `3001` is unreachable externally.

### 5.3 First-time setup

```bash
# as a user with docker access
git clone <repo> /opt/tugpt   # or: cd /opt/tugpt && git pull, if already checked out
cd /opt/tugpt

mkdir -p /etc/tugpt
chmod 700 /etc/tugpt
# /etc/tugpt/worker.env already exists — reuse it.
# create /etc/tugpt/web.env from .env.example, filled in with real
# production values, chmod 600.

cp deploy/systemd/tugpt.service /etc/systemd/system/tugpt.service
systemctl daemon-reload
```

Do **not** `systemctl enable --now tugpt.service` yet — see the cutover sequence in 5.4 first, so the containerized and systemd-native workers are never both polling the queues at once.

### 5.4 Cutover from systemd-native workers to Docker Compose

The existing `tugpt-whatsapp-worker` and `tugpt-draft-worker` systemd services and the new `tugpt.service` compose stack must never run at the same time — both would poll the same PGMQ queues (`whatsapp_inbound`, `draft_generation`) and double-process jobs. Cut over in one sequence, not gradually:

1. Build the images first, before touching the running services, so the cutover window is as short as possible:
   ```bash
   cd /opt/tugpt
   NEXT_PUBLIC_SUPABASE_URL=<...> NEXT_PUBLIC_SUPABASE_ANON_KEY=<...> \
     docker compose -p tugpt build
   ```
2. Stop and disable the systemd-native workers:
   ```bash
   systemctl stop tugpt-whatsapp-worker tugpt-draft-worker
   systemctl disable tugpt-whatsapp-worker tugpt-draft-worker
   ```
3. Start the compose stack:
   ```bash
   systemctl enable --now tugpt.service
   ```
4. Verify both workers are polling and nothing is double-running:
   ```bash
   docker compose -p tugpt -f /opt/tugpt/docker-compose.yml logs -f whatsapp-worker draft-worker
   # confirm log lines like "Worker started. Polling whatsapp_inbound queue..."
   # and "Draft worker started" appear exactly once each
   systemctl status tugpt-whatsapp-worker tugpt-draft-worker
   # confirm both show inactive/disabled
   ```
5. Only after step 4 is confirmed clean, treat the systemd-native unit files as the rollback path (kept on disk, disabled) rather than deleting them immediately — remove them in a later, separate change once the compose stack has proven stable.

If anything in step 4 looks wrong — either side polling when it shouldn't, or neither side polling — stop and do not proceed; re-enable the systemd-native workers (`systemctl enable --now tugpt-whatsapp-worker tugpt-draft-worker`) and stop the compose stack (`systemctl stop tugpt.service`) to get back to a known-good single source of truth while debugging.

### 5.5 Building and deploying a new release (post-cutover)

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

### 5.6 Explicitly not part of this deployment work

- Logicc credentials are still pending; `ai_draft_generation` stays `false`. Nothing here changes that.
- `whatsapp_integration` stays `false`. This section covers *where the app runs*, not turning features on.
