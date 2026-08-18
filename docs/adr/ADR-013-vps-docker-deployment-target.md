# ADR-013: VPS + Docker Compose Deployment Target (Replacing Vercel)

## Status
Accepted

## Context
The repository's `vercel.json`, `apps/web/README.md`, and the default `create-next-app` scaffolding all assumed the web app would deploy to Vercel. In practice, no `tugpt-nextjs-recovered` project exists under the connected Vercel account, and the account is being moved away from. The actual, current deployment target is a self-managed VPS at `87.106.48.96`, shared with another application ("The Infected"). That server has password-only SSH (no keys) and does not otherwise appear in this repository's history — there is no prior Docker, systemd, or deploy-script footprint to build on.

The workers (`apps/worker`) were never deployable via Vercel in the first place (Vercel doesn't run long-lived background processes), so a VPS-based, always-on runtime was always required for `whatsapp-worker` and `draft-worker`, even before this decision. This ADR formalizes the web app moving to the same model, and makes the deployment mechanism explicit and reviewable in code rather than assumed or done by hand on the server.

## Decision
1. **Runtime**: Docker Compose (`docker-compose.yml` at the repo root) defines three services — `web`, `whatsapp-worker`, `draft-worker` — built from `apps/web/Dockerfile` and `apps/worker/Dockerfile` respectively. The two worker services share one image and differ only by `command:` (`dist/index.js` vs `dist/draft-index.js`), matching the existing constraint that these must run as separate processes (see `apps/worker/src/draft-index.ts` header comment).
2. **Web build**: `apps/web/next.config.mjs` sets `output: 'standalone'` and `outputFileTracingRoot` to the monorepo root, so the Docker image ships only the traced runtime files rather than the full monorepo `node_modules`.
3. **Supervision**: A systemd unit (`deploy/systemd/tugpt.service`) wraps `docker compose -p tugpt up -d` / `down`, giving reboot-safety and `systemctl` ergonomics without needing a bespoke unit per process. Docker Compose owns process supervision (restart policy `unless-stopped`) within the stack; systemd owns "start the stack on boot."
4. **Secrets**: Environment variables are not baked into images or committed to git. Each service's `env_file` points at a root-owned file under `/etc/tugpt/` on the host (`web.env`, `worker.env`), continuing the `/etc/tugpt` convention already referenced in the project's status history.
5. **Coexistence with The Infected**: The `web` container binds only to `127.0.0.1:3001`, not `0.0.0.0:80`/`:443`. A single shared reverse proxy on the host (nginx or Caddy, not part of this repo) is expected to terminate TLS and route by hostname to each app's internal port. The Compose project is explicitly named `tugpt` (`-p tugpt`) so its containers and network are namespaced separately from any other app's stack on the same host.
6. **CI validation**: `.github/workflows/ci.yml` gained a `docker-build` job that builds both images on every push/PR, since there is no Docker daemon available to build-test these Dockerfiles outside of CI/the VPS itself.
7. **Explicitly out of scope for this ADR**: Logicc credential configuration and enabling `whatsapp_integration` remain untouched — this is a deployment-mechanism change only, not a feature-flag or provider-credential change.

## Consequences
- **No more Vercel assumptions**: `vercel.json` is removed; `apps/web/README.md` points at this ADR and `docs/production_environment.md` instead of the Vercel platform.
- **Manual verification required**: Because no Docker daemon was available in the environment that authored these Dockerfiles, they are validated only by the new CI job, not by a real `docker run` against Supabase/provider credentials. The first real deploy to `87.106.48.96` should be treated as the actual integration test and watched closely.
- **Open question — port allocation**: The Infected's repository currently documents a Vercel deployment (`theinfected.app`) with no VPS port footprint. Before the first shared deploy, someone needs to confirm what internal port The Infected's proxy config expects, so it and TuGPT's `127.0.0.1:3001` don't collide, and add a small port registry to `docs/production_environment.md` as more apps land on this host.
- **Reversible**: If the VPS plan changes again, the Docker images are portable to any container host (including Vercel's own container-adjacent offerings, or another cloud VM) without further rework.
