# Milestone #1 — First End-to-End AI Draft (Runbook)

**Target server:** `212.227.44.13`
**Status:** ready to execute; blocked only on the merged `main` being deployed to the server.

## 1. What this proves

One synthetic customer message travels the entire pipeline and comes out the other side as a
human-approved draft, with the audit trail and quota accounting to show for it:

```
synthetic inbound message
  -> ingest_whatsapp_message_event      (service-role RPC)
  -> whatsapp_inbound PGMQ queue
  -> tugpt-whatsapp-worker -> process_inbound_message
  -> draft_generation PGMQ queue
  -> tugpt-draft-worker -> Langdock (auto model routing)
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

## 6. Prerequisites on the server

- Merged `main` deployed to `/opt/tugpt` (commit `37a957a` or later — the Langdock-only provider).
- `LANGDOCK_API_CODE` present in `/etc/tugpt/worker.env`.
- `tugpt-whatsapp-worker` and `tugpt-draft-worker` both running, restarted since the deploy.
- No new credentials needed: the harness reads the same env files the workers already use.

## 7. Commands

```bash
cd /opt/tugpt

# --- deploy the merged main ---
git fetch origin && git checkout main && git pull --ff-only origin main
pnpm install --frozen-lockfile

# --- confirm the Langdock key is present (prints only the variable name) ---
grep -q '^LANGDOCK_API_CODE=' /etc/tugpt/worker.env \
  && echo "LANGDOCK_API_CODE: present" \
  || echo "LANGDOCK_API_CODE: MISSING - add it before continuing"

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
- recent `audit_logs` and `failed_jobs`

It also asserts, and fails the run on: any outbound message existing, `whatsapp_integration` being
enabled, and a stale-version approve being accepted (which would mean optimistic locking is broken).

## 9. Failure triage

| Symptom | Meaning | Fix |
|---|---|---|
| `90003 CONNECTION_NOT_FOUND` | connection row missing or `status != 'active'` | re-run `seed` |
| Job `skipped`, `FEATURE_DISABLED` | the flag AND did not resolve true | check the global row is `true` (§3) |
| Job `skipped`, quota reason | no live quota period, or ceiling hit | re-run `seed` |
| Job `dead_lettered`, `DRAFT_PROVIDER_CONFIG_ERROR` | `LANGDOCK_API_CODE` missing from the draft worker's env | add it to `/etc/tugpt/worker.env`, restart |
| Job `dead_lettered`, `DRAFT_PROVIDER_AUTH_ERROR` | key present but rejected by Langdock | check the key is valid and current |
| Job `dead_lettered`, `DRAFT_EXHAUSTED_RETRIES` | three transient failures — Langdock down or rate limiting | retry later; single-provider means no fallback (ADR-006) |
| Timeout, no `messages` row | whatsapp worker not consuming | `systemctl status tugpt-whatsapp-worker` |
| Timeout, message but no draft | draft worker not consuming | `systemctl status tugpt-draft-worker` |
| `P3B02 FORBIDDEN` on review | reviewer not a member, or no user JWT | pass `--env-file /etc/tugpt/web.env` |

## 10. After the run

The harness leaves the synthetic org, conversation, message and draft in place — `audit_logs` are
immutable by design, and keeping the org lets the run be repeated without reseeding. `teardown`
switches both `ai_draft_generation` rows back to `false`, which is the state that matters.

Deleting the org outright needs care: `DELETE FROM public.organizations` is silently converted to a
soft delete by `trigger_soft_delete_organizations`, and the harness refuses to run against a
soft-deleted org.
