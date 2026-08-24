# Milestone #1 — First End-to-End AI Draft (Runbook)

**Target server:** `212.227.44.13`
**Status:** milestone #1 accepted 2026-08-19 — draft generated via `langdock/gpt-5-mini`, edited and
approved by a real reviewer, quota and audit trail correct, zero outbound. That run, however,
executed against a database missing migration `20260819000001` (the push had failed and nobody was
forced to notice), so the preflight now blocks on a stale schema — see §6b and
[docs/server-migrations.md](server-migrations.md).

## 0. Re-run after the 2026-08-19 fix

The existing seed is still valid — org, connection, draft config, quota and flags were all created
correctly on the first run, and the `ai_draft_generation` global flag is still `true`. **No teardown
is needed first.** Re-running `all` re-seeds idempotently and injects a *new* message with a fresh
`provider_message_id`, so it does not collide with the failed job, which stays in place as evidence.

Two things must be in place before re-running, both new in this fix:

1. **All migrations applied.** Preflight now verifies this and aborts if the checkout is ahead of
   the database (§6b). The apply procedure for the server is
   [docs/server-migrations.md](server-migrations.md) — `supabase db push` alone fails on the VPS
   with `Cannot find project ref`.
2. **`LANGDOCK_MODELS` in `/etc/tugpt/worker.env`.** Defaults to the full allowlist if absent, but
   set it explicitly so the effective rotation order is visible in the file rather than implied by
   code (§6a).

Full command sequence is in §7. **The run must end with `teardown`**, which sets the global
`ai_draft_generation` row back to `false`.

## 1. What this proves

One synthetic customer message travels the entire pipeline and comes out the other side as a
human-approved draft, with the audit trail and quota accounting to show for it:

```
synthetic inbound message
  -> ingest_whatsapp_message_event      (service-role RPC)
  -> whatsapp_inbound PGMQ queue
  -> tugpt-whatsapp-worker -> process_inbound_message
  -> draft_generation PGMQ queue
  -> tugpt-draft-worker -> Langdock (LANGDOCK_MODELS rotation, default gpt-5-mini first)
  -> store_draft   (ai_drafts + ai_draft_revisions + quota consume)
  -> human edit + approve, as a real signed-in user
  -> audit trail + quota decrement
```

Nothing is ever sent to a customer. `whatsapp_integration` stays `false` throughout, and the
harness refuses to run if it is not.

## 2. Why the message is injected via RPC rather than the webhook

The HTTP webhook (`apps/web/src/app/api/v1/webhooks/whatsapp/route.ts`) returns **404 on both GET
and POST** whenever `whatsapp_integration` is disabled — that is the first thing both handlers
check. So while the flag is off, as it must be, the HTTP endpoint cannot be used even with a
correctly signed synthetic payload.

The harness therefore calls `ingest_whatsapp_message_event` directly. That is the exact function
the webhook route itself calls, with the same arguments, so **everything from ingest onward is the
real production path, unmodified**. Only the HTTP transport and Meta's signature check are bypassed
— and neither is under test here; they are covered separately and gated behind Meta readiness.

## 3. The feature-flag correction (read before running)

`ai_draft_generation` **cannot** be enabled for a single organization while the global flag stays
`false`. `public.is_feature_enabled` is a logical AND, not an override chain:

```sql
SELECT COALESCE(
  (SELECT is_enabled FROM feature_flags WHERE organization_id IS NULL AND key = p_flag_key)
  AND
  COALESCE((SELECT is_enabled FROM feature_flags
            WHERE organization_id = p_organization_id AND key = p_flag_key), false),
  false);
```

The global row is a **kill switch**: while it is `false`, every org resolves to `false` no matter
what its own row says. Enabling drafts for the test org therefore requires setting the global row
to `true` as well.

**Tenant isolation is still exact.** Every other organization has no org-scoped row, so its side of
the AND coalesces to `false`. The harness proves this rather than asserting it: after seeding, it
calls `is_feature_enabled` for every other org and aborts if any resolves `true`.

To turn everything off instantly, set the global row back to `false` — one statement disables draft
generation everywhere. `teardown` does exactly that.

## 4. Test organization

Created fresh, never reused from anything real. All identifiers are deliberately impossible to
confuse with production data:

| Item | Value |
|---|---|
| Org slug | `internal-e2e-test` |
| Org name | `Internal E2E Test (synthetic - not a customer)` |
| Provider phone id | `E2E-SYNTHETIC-PHONE-ID-DO-NOT-USE` (Meta ids are numeric; this can never collide) |
| Business number | `+00000000000` |
| Customer number | `+00000000001` |
| Reviewer | `e2e-reviewer@internal-e2e-test.invalid` (`.invalid` is reserved by RFC 2606 — never deliverable) |
| Quota ceiling | 25 drafts / 30 days |

## 5. Safety invariants, enforced on every command

1. **Aborts if `whatsapp_integration` is enabled anywhere.** Re-checked before every step, not just
   at seed time.
2. **Only ever touches the `internal-e2e-test` org.** It also refuses to run if that org contains a
   conversation with a non-synthetic contact phone, which would suggest the slug was reused.
3. **Asserts zero outbound messages** for the org at the end.
4. **Verifies its own privilege level** during the review step: the "user" client must *fail* to
   read `draft_generation_jobs` (service-role only). Without that check, a misconfigured client
   could pass the review test while silently running as service-role.
5. **Refuses to run against a stale schema.** Every migration in the checkout must be present in the
   database, and the objects the worker depends on are probed directly (§6b). Added after the
   2026-08-19 run passed against a database missing `20260819000001`.

## 6. Prerequisites on the server

- Merged `main` deployed to `/opt/tugpt`.
- `LANGDOCK_API_CODE` present in `/etc/tugpt/worker.env`.
- **`LANGDOCK_MODELS` (or `LANGDOCK_MODEL`) present in `/etc/tugpt/worker.env`** — see §6a.
- Migrations applied through `20260819000002` — see [docs/server-migrations.md](server-migrations.md).
- `/etc/tugpt/migrate.env` present (root-owned, `0600`) if you need to apply migrations.
- `tugpt-whatsapp-worker` and `tugpt-draft-worker` both running, restarted since the deploy.
- No new credentials needed: the harness reads the same env files the workers already use.

### 6a. Model selection and rotation

The first run failed because the adapter sent `model: "auto"`, which Langdock's OpenAI-compatible
endpoint does not accept — it returns HTTP 400 with the list of real models. Model selection is now
explicit and validated at worker boot against a four-model allowlist:

| Model | Notes |
|---|---|
| `gpt-5-mini` | Cheapest; head of the default rotation order |
| `gpt-5.1` | Allowed |
| `gpt-5.2` | Allowed |
| `gpt-5` | Allowed |

Every other model Langdock offers (`o3`, `o4-mini`, `gpt-5.4*`, `gpt-5.5`, `gpt-5.6-*`,
`gpt-5.2-pro`, `langdock-llama-3.3-70b-2`) is forbidden on cost grounds and is **rejected at boot**,
even if the env var names it. `auto` is likewise rejected. Changing models is an env edit plus a
worker restart — never a code deploy.

**Rotation (new).** Each approved model has its own Langdock quota (500 requests / 250k tokens), so
they are four independent capacity buckets. On a per-model quota rejection the worker tries the next
model in the configured order within the same attempt:

| Variable | Effect |
|---|---|
| `LANGDOCK_MODELS=gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5` | **Recommended.** Rotation in that order. |
| `LANGDOCK_MODEL=gpt-5-mini` | Pins one model, rotation off. The escape hatch, and back-compatible for hosts configured before rotation existed. |
| neither | Defaults to the full allowlist, cheapest first. |

`LANGDOCK_MODELS` wins if both are set, and the worker logs that `LANGDOCK_MODEL` was ignored.
Rotation is narrow on purpose: only a 429, or a 400 in which the provider says the model is unknown.
Auth failures, malformed requests, timeouts and 5xx do **not** rotate — see ADR-006.

**Check which one the server actually has** rather than assuming. This paragraph used to assert
that the server was pinned to a single model; the host was reinstalled from scratch on 2026-08-24
and `/etc/tugpt/worker.env` is being recreated, so any claim here about what is set would be a
guess. The worker settles it at boot:

```bash
journalctl -u tugpt-draft-worker -n 50 --no-pager | grep 'model order resolved'
```

That line reports the resolved order, which variable it came from (`LANGDOCK_MODELS`,
`LANGDOCK_MODEL`, or `default`), and whether rotation is enabled. It is the only answer that
cannot be stale.

To move a pinned host onto rotation:

```bash
sudo sed -i 's/^LANGDOCK_MODEL=.*/LANGDOCK_MODELS=gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5/' \
  /etc/tugpt/worker.env
sudo systemctl restart tugpt-draft-worker
journalctl -u tugpt-draft-worker -n 20 --no-pager | grep 'model order resolved'
```

### 6b. Schema gate (new)

Preflight verifies the database matches the checkout and **aborts the run** if it does not. This
replaces the warning that let the 2026-08-19 run report success against a database missing
`20260819000001`.

Two layers, both fatal:

1. **Ledger diff** — every `.sql` in `supabase/migrations` must have a row in
   `supabase_migrations.schema_migrations`. Generic: new migration files are covered with no code
   change. The ledger is read through `applied_migration_versions()`, a `SECURITY DEFINER` function
   granted to `service_role` only (added in `20260819000002`); it returns version and name, never
   the migration SQL.
2. **Effect probes** — the objects the worker actually depends on are queried directly, because a
   ledger row proves a migration was *recorded*, not that it *took effect*.

Both are read-only. The `archive_draft_failed_job` probe calls the RPC with a random job id, which
is rejected with `P3B07` before anything is written.

On failure the harness prints the missing migrations, what each one's absence breaks, and the exact
apply command. Fix with [docs/server-migrations.md](server-migrations.md), then re-run `preflight`.

## 7. Commands

```bash
cd /opt/tugpt

# --- deploy the merged main ---
git fetch origin && git checkout main && git pull --ff-only origin main
pnpm install --frozen-lockfile

# --- apply migrations. `db push` with no target fails on this box with
#     "Cannot find project ref"; --db-url avoids linking entirely.
#     Full procedure and how to build the URL: docs/server-migrations.md ---
set -a; . /etc/tugpt/migrate.env; set +a
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"

# --- set the model rotation order, then confirm the variables are present
#     (prints variable names only, never values) ---
grep -q '^LANGDOCK_MODELS=' /etc/tugpt/worker.env \
  || echo 'LANGDOCK_MODELS=gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5' | sudo tee -a /etc/tugpt/worker.env

for v in LANGDOCK_API_CODE LANGDOCK_MODELS; do
  grep -q "^$v=" /etc/tugpt/worker.env \
    && echo "$v: present" || echo "$v: MISSING"
done

# --- restart the workers on the new code ---
sudo systemctl restart tugpt-whatsapp-worker tugpt-draft-worker
sleep 5
systemctl is-active tugpt-whatsapp-worker tugpt-draft-worker

# --- dry run: connectivity + safety checks only, makes no writes ---
pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts preflight \
  --env-file /etc/tugpt/worker.env --env-file /etc/tugpt/web.env

# --- full run, capturing the evidence pack ---
pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts all \
  --env-file /etc/tugpt/worker.env --env-file /etc/tugpt/web.env \
  2>&1 | tee /tmp/milestone1-evidence.txt

# --- worker logs for the same window, to attach to the evidence pack ---
journalctl -u tugpt-draft-worker --since '15 min ago' --no-pager \
  > /tmp/milestone1-draft-worker.log
journalctl -u tugpt-whatsapp-worker --since '15 min ago' --no-pager \
  > /tmp/milestone1-whatsapp-worker.log

# --- switch draft generation back off when finished ---
pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts teardown \
  --env-file /etc/tugpt/worker.env
```

`--env-file /etc/tugpt/web.env` is what supplies `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Without it
everything up to draft generation still runs, but the human-review leg is skipped with a warning:
`approve_draft` / `edit_draft` / `reject_draft` check `auth.uid()`, which is `NULL` under the
service-role key, so they must be driven with a genuine user JWT.

## 8. Evidence pack

`milestone1.ts all` prints a JSON evidence pack containing:

- resolved `ai_draft_generation` and `whatsapp_integration` flag rows
- the `webhook_events` receipt (status, attempt count, processed timestamp)
- the conversation and the inbound `messages` row
- the `draft_generation_jobs` row — status, attempts, **provider and model actually used**
- the `ai_drafts` row and every `ai_draft_revisions` row (v1 system-generated, v2 human-edited)
- every `ai_draft_review_events` row (edit, approve) with actor and version transitions
- `draft_quota_limits`, `draft_usage_tracking` (`draft_count` / `reserved_count`), and the
  `draft_usage_reservations` row showing the reservation consumed
- recent `audit_logs` and `failed_jobs`, including `provider_error_detail` — the provider's own
  error text on any dead-lettered job, sanitized and truncated

It also asserts, and fails the run on: any outbound message existing, `whatsapp_integration` being
enabled, and a stale-version approve being accepted (which would mean optimistic locking is broken).

## 9. Failure triage

| Symptom | Meaning | Fix |
|---|---|---|
| `90003 CONNECTION_NOT_FOUND` | connection row missing or `status != 'active'` | re-run `seed` |
| Job `skipped`, `FEATURE_DISABLED` | the flag AND did not resolve true | check the global row is `true` (§3) |
| Job `skipped`, `QUOTA_DENIED` | no live quota period, or ceiling hit. `QUOTA_DENIED` is the only skip reason a quota denial writes | re-run `seed` |
| Job `dead_lettered`, `DRAFT_INVALID_REQUEST` | the provider rejected the request (4xx) | read `failed_jobs.provider_error_detail` — it quotes the provider verbatim |
| Job `dead_lettered`, `DRAFT_PROVIDER_CONFIG_ERROR` | `LANGDOCK_API_CODE` missing, or a model off the allowlist / duplicated in `LANGDOCK_MODELS` | fix `/etc/tugpt/worker.env`, restart |
| Job `dead_lettered`, `DRAFT_EXHAUSTED_RETRIES`, detail says `model(s) exhausted` | every model's quota is spent | wait for the quota window, or widen `LANGDOCK_MODELS` |
| Job `dead_lettered`, `DRAFT_PROVIDER_AUTH_ERROR` | key present but rejected by Langdock | check the key is valid and current |
| Job `dead_lettered`, `DRAFT_EXHAUSTED_RETRIES` | three genuinely transient failures — Langdock down or rate limiting | retry later; single-provider means no fallback (ADR-006) |
| Job `dead_lettered`, `DRAFT_INTERNAL_ERROR` | an archive was rejected and fell back | the log line names the code that was refused — the worker/RPC allowlists have drifted again |
| Timeout, no `messages` row | whatsapp worker not consuming | `systemctl status tugpt-whatsapp-worker` |
| Timeout, message but no draft | draft worker not consuming | `systemctl status tugpt-draft-worker` |
| `P3B02 FORBIDDEN` on review | reviewer not a member, or no user JWT | pass `--env-file /etc/tugpt/web.env` |
| `REFUSING TO RUN: the database is not running the schema this checkout expects` | migrations in the checkout are not applied | [docs/server-migrations.md](server-migrations.md) §1 |
| `migration ledger unreadable` | `applied_migration_versions()` not installed, i.e. `20260819000002` not applied | same — apply migrations |

## 10. After the run

The harness leaves the synthetic org, conversation, message and draft in place — `audit_logs` are
immutable by design, and keeping the org lets the run be repeated without reseeding. `teardown`
switches both `ai_draft_generation` rows back to `false`, which is the state that matters.

Deleting the org outright needs care: `DELETE FROM public.organizations` is silently converted to a
soft delete by `trigger_soft_delete_organizations`, and the harness refuses to run against a
soft-deleted org.
