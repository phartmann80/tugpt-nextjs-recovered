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
| `LANGDOCK_API_CODE` | Production Langdock Integration API Key (sole draft provider, see ADR-006) | **SECRET**. Server-side only. |
| `LANGDOCK_ENDPOINT_URL` | Production Langdock Endpoint URL (optional — defaults to `https://api.langdock.com/openai/eu/v1`) | Server-side only. |
| `LANGDOCK_MODELS` | Ordered rotation list, cheapest first, e.g. `gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5`. On a per-model quota rejection the next model is tried within the same attempt. Defaults to the whole allowlist when unset. **This is what the server runs.** See ADR-006. | Server-side only. Not a secret. |
| `LANGDOCK_MODEL` | Pins exactly one model and disables rotation. Kept for deployments predating rotation, and as the escape hatch. Ignored when `LANGDOCK_MODELS` is also set — the more specific variable wins, and the override is logged at boot. Allowed values: `gpt-5-mini`, `gpt-5.1`, `gpt-5.2`, `gpt-5`. Anything else is rejected at worker boot. | Server-side only. Not a secret. |
| `GATEWAY_API_MASTRA_KEY` | Production Mastra Orchestrator API Key | **SECRET**. Server-side only. |
| `GATEWAY_API_URL` | Production Mastra Endpoint URL | Server-side only. |
| `TUGPT_DOMAIN` | Public hostname the dashboard is served on, e.g. `dashboard.tugpt.ai`. Read by the Caddy reverse proxy only (section 5.4b), and only when the `proxy` compose profile is enabled. Not needed for the loopback-only deployment in 5.4a. | Not a secret. |

**Removed as of 2026-08-18 (see ADR-006):** `LOGICC_API_KEY`, `LOGICC_ENDPOINT_URL`, `LOGICC_DEFAULT_MODEL`, `ANYMIZE_API_KEY`, `ANYMIZE_ENDPOINT_URL`, `ANYMIZE_DEFAULT_MODEL`, and `MODEL` are no longer read anywhere in the codebase. Logicc was cut for cost; Anymize was removed to avoid cross-project coupling (it remains in use on other projects). Do not add these back without a separate, explicit decision.

**Correction (2026-08-19):** this section previously said model selection was Langdock's `auto` routing and that no model env var was needed. That was wrong — Langdock's OpenAI-compatible endpoint has no `auto` model and returns HTTP 400 for it. Model selection is now `LANGDOCK_MODELS` (rotation) or `LANGDOCK_MODEL` (pinned), validated against a four-model allowlist. The generic `MODEL` variable really is dead: its last reader was deleted with `AIProviderFactory` in PR #17.

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

TuGPT runs on its own dedicated VPS at **`212.227.44.13`** — not a shared host, not Vercel. Vercel is no longer used at all; the deployment model is push to GitHub, deploy to this server. This is the same server that already runs `tugpt-whatsapp-worker` and `tugpt-draft-worker` as systemd-native Node processes today.

**Read 5.4a before 5.4.** As of 2026-08-20 only the **web app** has been authorized to move onto Docker; the workers stay systemd-native and untouched. 5.4a is that deployment, and 5.4b makes it reachable from a browser. 5.4 below is the *worker* cutover — a separate, later change that retires the native units in one sequence rather than running both side by side, and that must not be started early.

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

Interim (as of 2026-08-20 — web on Docker, workers still native):

```
/opt/tugpt/
  docker-compose.yml
  apps/web/Dockerfile
  deploy/caddy/Caddyfile           # only used when the `proxy` profile is enabled (5.4b)
/etc/systemd/system/
  tugpt-web.service                # (new) runs ONLY the compose `web` service
  tugpt-whatsapp-worker.service    # unchanged, still enabled and running
  tugpt-draft-worker.service       # unchanged, still enabled and running
```

This is the state section 5.4a produces, and the one to deploy today. `tugpt.service` is not installed or enabled in it — see 5.4a for why enabling it now would double-consume the queues.

`worker.env` already exists on this server and can be reused as-is for the containerized workers — same variable names, same file. `web.env` is new (the web app has never been deployed to this server before) and, in addition to the server secrets, needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` available as Docker build args (see 5.3), because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle at build time, not at container start.

### 5.2 Pre-deploy security checklist

Confirm each of these against the actual state of `212.227.44.13` before proceeding. If confirming any of them requires access this session doesn't have, that needs to be granted (or the check run by whoever already has access) before cutover:

- [ ] SSH key-based auth is enabled and password auth is disabled (`PasswordAuthentication no` in `sshd_config`).
- [ ] `ufw` (or equivalent) allows only 22 (SSH), 80, and 443 inbound; no other ports reachable from the public internet.
- [ ] No application port (`3001` for `web`, or any worker) is bound to `0.0.0.0` — loopback-only, confirmed with `ss -tlnp` after the stack is up. (80 and 443 are bound publicly by the `proxy` profile when it is enabled, 5.4b — that is the one intended exception.)
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

cp deploy/systemd/tugpt-web.service /etc/systemd/system/tugpt-web.service
systemctl daemon-reload
```

Install `tugpt-web.service`, not `tugpt.service` — see 5.4a. `tugpt.service` supervises the *whole* compose stack, including worker containers, and belongs to the worker cutover in 5.4. Do **not** `systemctl enable --now tugpt.service` while the systemd-native workers are running, or both will poll the same queues at once.

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

### 5.4a Web-only deployment (authorized 2026-08-20 — workers stay on systemd)

This is the sequence to run **today**. Section 5.4 above is the *worker* cutover and is not authorized: the workers stay exactly as they are, systemd-native, untouched.

The distinction matters because `tugpt.service` brings up the whole compose file — `web`, `whatsapp-worker` and `draft-worker`. Starting it now would put a second consumer on `whatsapp_inbound` and `draft_generation` alongside the running native units and double-process every message. `tugpt-web.service` exists for exactly this situation: it runs `docker compose up -d --build web` and nothing else. The two units declare `Conflicts=` on each other so they cannot both be active.

```bash
cd /opt/tugpt
git pull                                  # deploy the intended commit

# One-time: create /etc/tugpt/web.env from .env.example with real values,
# chown root:root, chmod 600. It needs NEXT_PUBLIC_SUPABASE_URL,
# NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY at minimum.
install -m 600 -o root -g root /dev/null /etc/tugpt/web.env   # then edit it

cp deploy/systemd/tugpt-web.service /etc/systemd/system/tugpt-web.service
systemctl daemon-reload
systemctl enable --now tugpt-web.service
```

**Why the env file has to be sourced for a manual build.** Next.js inlines `NEXT_PUBLIC_*` at build time, into the *server* bundle as well as the client one, so those two values must be present as Docker build args. `docker-compose.yml` declares them with `${VAR:?...}`, which fails the build loudly rather than baking empty strings. `tugpt-web.service` supplies them via `EnvironmentFile=/etc/tugpt/web.env`; building by hand does not, so source it first:

```bash
set -a; . /etc/tugpt/web.env; set +a
docker compose -p tugpt up -d --build web
```

Getting this wrong used to be silent and total: an image built with empty `NEXT_PUBLIC_SUPABASE_URL` sends every `/dashboard` request to `/auth/login` (see the guard in `apps/web/src/proxy.ts`), `server.ts` throws "Supabase URL is missing", and every `/api/v1` route builds a client against `''`. The app looks deployed and is entirely dead, and it reads like an authentication bug rather than a build one.

**Verify.**

```bash
# The workers must be exactly as they were — this deploy does not touch them.
systemctl is-active tugpt-whatsapp-worker tugpt-draft-worker    # active, active

# Exactly one container, and it is web.
docker compose -p tugpt ps

# Loopback only. 3001 must not appear on 0.0.0.0 (see 5.2).
ss -tlnp | grep 3001

# Health.
curl -fsS http://127.0.0.1:3001/api/v1/health
# {"status":"ok","app":"TuGPT.ai","version":"1.0.0",...}

docker compose -p tugpt logs --tail=50 web
```

**Rollback** is `systemctl disable --now tugpt-web.service`. Nothing else on the host is affected, because nothing else was changed.

**Two things this does not do, both deliberate:**

- **No public reachability.** The container binds `127.0.0.1:3001` only. The dashboard is reachable *on* the server and from nowhere else. Section 5.4b closes that gap and is a separate, opt-in step.
- **No feature flags move.** `ai_draft_generation` and `whatsapp_integration` stay disabled. This section is about where the app runs.

### 5.4b Making the dashboard reachable from a browser (optional, opt-in)

5.4a leaves the app listening on loopback. A reviewer cannot open it. This adds TLS termination and public routing in front of it.

Caddy rather than nginx: certificates are obtained and renewed from Let's Encrypt automatically, with no certbot, no cron entry, and no renewal that can quietly stop working. The whole configuration is `deploy/caddy/Caddyfile`, about twenty lines.

**It is off by default.** The compose service carries `profiles: ["proxy"]`, so `docker compose up -d web` neither starts it nor can start it by accident, and `tugpt-web.service` is unaffected.

**Before enabling:**

- [ ] A DNS `A` record (and `AAAA` if the host has IPv6) for the intended hostname points at `212.227.44.13`. Caddy proves control of the name to Let's Encrypt; without working DNS it cannot get a certificate.
- [ ] `TUGPT_DOMAIN=<that hostname>` is in `/etc/tugpt/web.env`. If it is missing, Caddy starts and then fails to obtain a certificate for `TUGPT_DOMAIN-is-not-set.invalid` — the name is chosen so the log line names the problem.
- [ ] `ufw` allows 80 and 443 inbound (5.2 already assumes this). Both are needed: 80 for the ACME challenge and for the HTTP→HTTPS redirect.

```bash
cd /opt/tugpt
docker compose -p tugpt --profile proxy up -d caddy
```

**Verify:**

```bash
docker compose -p tugpt --profile proxy ps            # web + caddy
docker compose -p tugpt logs --tail=50 caddy          # watch the certificate get issued
curl -fsSI http://$TUGPT_DOMAIN/api/v1/health         # 308 redirect to https
curl -fsS  https://$TUGPT_DOMAIN/api/v1/health        # {"status":"ok",...}
```

Then open `https://<TUGPT_DOMAIN>/auth/login` and sign in.

**To stop it** without touching the app: `docker compose -p tugpt --profile proxy stop caddy`. The web container keeps serving on loopback.

**A correction to what 5.4a used to say.** It claimed Supabase Auth would need the new origin in its redirect allowlist before anyone could log in. That is wrong for the flow this app actually uses: `apps/web/src/app/auth/login/page.tsx` calls `supabase.auth.signInWithPassword`, a direct API call from the browser that involves no redirect URL at all. **Email/password sign-in works as soon as the proxy is up, with no Supabase configuration change.**

Where `site_url` and the redirect allowlist *do* matter:

- The `/auth/callback` page, which handles an OAuth code exchange. Nothing routes to it today, but it exists and would need the origin allowlisted before any OAuth provider is switched on.
- Confirmation and password-recovery emails. `supabase/config.toml` sets `enable_confirmations = true`, so a newly created reviewer receives a confirmation link built from `site_url`. If that still points at the retired Vercel deployment, the link lands nowhere. Worth fixing when reviewer accounts are created — Supabase configuration, not a repo change.

**On the WhatsApp webhook.** Once this is up, `https://<TUGPT_DOMAIN>/api/v1/webhooks/whatsapp` is publicly reachable, which is what Meta will eventually require. It returns 404 today and keeps returning 404 until `whatsapp_integration` is flipped in `packages/feature-flags/src/flags.ts` — a reviewed code change, per ADR-010 amendment 2. Exposing the path does not enable the feature and does not move it closer to enabled.

### 5.5 Building and deploying a new release (post-cutover)

Until the worker cutover happens, the interim equivalent is two lines — `tugpt-web.service` sources the env file itself, so there is no separate build step to get the args right:

```bash
cd /opt/tugpt && git pull
systemctl restart tugpt-web
```

The proxy does not need restarting for an app release; it is a separate container and routes to whatever `web` is currently serving.

After the worker cutover:

```bash
cd /opt/tugpt
git pull
NEXT_PUBLIC_SUPABASE_URL=<...> \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<...> \
docker compose -p tugpt build
systemctl restart tugpt
docker compose -p tugpt logs -f   # watch startup
```

`systemctl restart tugpt` re-runs `docker compose up -d --build`, and both units now carry `EnvironmentFile=/etc/tugpt/web.env`, so a restart supplies the `NEXT_PUBLIC_*` build args on its own. The explicit `build` step is only needed when building by hand outside systemd — and in that case source the env file first (5.4a), because `docker-compose.yml` declares those args with `${VAR:?...}` and will refuse to build without them rather than bake empty strings into the image.

### 5.6 Explicitly not part of this deployment work

- Langdock production credentials and enabling `ai_draft_generation` are handled separately — the provider work (ADR-006, rotation in PR #23) is merged and `LANGDOCK_MODELS` is set on the server, but turning the feature on is the controlled rollout in `docs/controlled-rollout.md`, not a deployment step. Nothing here changes that.
- `whatsapp_integration` stays `false`. This section covers *where the app runs*, not turning features on.
