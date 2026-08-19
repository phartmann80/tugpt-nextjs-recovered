# Controlled rollout: turning on AI draft generation

**Status:** active procedure
**Applies to:** `ai_draft_generation` on `212.227.44.13` / project `rbiumegrwtavmljxbknp`
**Flag semantics this depends on:** ADR-010, "Amendment (2026-08-19): what the flags actually do"

> **Outbound WhatsApp is out of scope.** `whatsapp_integration` stays off. Nothing in this document
> turns it on, and nothing in this document can — see §7. Enabling outbound customer messaging
> requires explicit owner approval, every time, without exception.

---

## 1. The two switches

`public.is_feature_enabled(org, key)` is a **logical AND** of the global row
(`organization_id IS NULL`) and the org row. It is not an override chain. Everything below follows
from that one fact:

- **Global row = the arming switch.** While it is `false`, the feature is off for every
  organization regardless of what their own rows say. Setting it to `true` turns the feature on for
  *nobody* — it only stops the global row from vetoing.
- **Org row = an allowlist entry.** An organization is enabled only when it has its own row set to
  `true` *and* the global row is `true`. An organization with no row resolves to `false`.

This is why a pilot cannot be run with the global row left `false`, and why arming globally is not
the risk it sounds like: with zero org rows, arming changes nothing observable. §3 proves that
rather than assuming it.

## 2. Before you start

- [ ] Migrations applied and the harness preflight passes — `docs/server-migrations.md` §4.
- [ ] Both workers active on the deployed commit:
      `systemctl is-active tugpt-draft-worker tugpt-whatsapp-worker`
- [ ] `LANGDOCK_API_CODE` and `LANGDOCK_MODEL` present in `/etc/tugpt/worker.env`
      (`docs/milestone1-e2e-runbook.md` §6a).
- [ ] Each pilot organization has a **live quota period** — a `draft_quota_limits` row whose
      `period_start <= CURRENT_DATE < period_end`. Without one, every job is skipped with
      `NO_ACTIVE_QUOTA_PERIOD` and the rollout looks broken when it is merely unbudgeted.
- [ ] Each pilot organization has an `ai_draft_configs` row. Without it the prompt has no business
      instructions and the drafts are generic.
- [ ] You know who is watching, and for how long. Step 4 is not optional.

Run every statement below against the database with a service-role or owner connection. Take the
"before" reading in §3 first — you will want it if you have to explain what changed.

## 3. Arm globally, and prove nothing turned on

```sql
-- Before: every row for this flag.
SELECT organization_id, is_enabled
FROM public.feature_flags
WHERE key = 'ai_draft_generation'
ORDER BY organization_id NULLS FIRST;
```

Expect exactly one row, `organization_id = NULL`, `is_enabled = false`. **If any org row already
exists and is `true`, stop** — arming will enable that organization the instant you do it. Resolve
that first.

```sql
-- Arm.
UPDATE public.feature_flags
SET is_enabled = true, updated_at = now()
WHERE organization_id IS NULL AND key = 'ai_draft_generation';
```

Now prove the claim in §1 rather than trusting it:

```sql
-- Must return zero rows. Any row here is an organization that just became live.
SELECT o.id, o.slug
FROM public.organizations o
WHERE o.deleted_at IS NULL
  AND public.is_feature_enabled(o.id, 'ai_draft_generation');
```

If that returns anything, disarm immediately (§6) and find out why before continuing.

## 4. Enable the first organization

One organization. Not two, not "the small ones".

```sql
INSERT INTO public.feature_flags (organization_id, key, is_enabled)
VALUES ('<ORG_UUID>', 'ai_draft_generation', true)
ON CONFLICT (organization_id, key) DO UPDATE SET is_enabled = true, updated_at = now();

-- Confirm the intended org resolves true, and re-confirm nobody else does.
SELECT o.slug, public.is_feature_enabled(o.id, 'ai_draft_generation') AS enabled
FROM public.organizations o
WHERE o.deleted_at IS NULL
ORDER BY enabled DESC, o.slug;
```

Exactly one `true`. Note the time — the monitoring window starts now.

## 5. Watch

Watch for **at least one full business day**, and through at least one busy period. Drafts are only
generated when customers actually message, so a quiet evening proves nothing.

**Job outcomes.** The single most informative query:

```sql
SELECT status, error_code, skip_reason, count(*), max(created_at) AS latest
FROM public.draft_generation_jobs
WHERE organization_id = '<ORG_UUID>'
  AND created_at > now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

| What you see | What it means | Do |
|---|---|---|
| `completed`, no error | working | continue |
| `skipped` / `FEATURE_DISABLED` | the AND did not resolve true — usually the global row | re-check §3 |
| `skipped` / quota reason | no live quota period, or the ceiling is hit | fix the quota, not the flag |
| `dead_lettered` / `DRAFT_INVALID_REQUEST` | the provider rejected the request | read `failed_jobs.provider_error_detail`; it quotes the provider |
| `dead_lettered` / `DRAFT_PROVIDER_CONFIG_ERROR` | `LANGDOCK_API_CODE` missing or `LANGDOCK_MODEL` off the allowlist | fix the env file, restart the worker |
| `dead_lettered` / `DRAFT_EXHAUSTED_RETRIES` | three genuinely transient failures | Langdock is degraded; single-provider means no fallback (ADR-006) |
| Anything at all in a **different** organization | isolation failure | **disarm now** (§6) |

**Dead letters, with the provider's own words:**

```sql
SELECT created_at, error_code, attempts, provider_error_detail
FROM public.failed_jobs
WHERE queue_name = 'draft_generation'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

**Cost and quota** — the reason the model allowlist exists:

```sql
SELECT period_start, period_end, draft_count, reserved_count
FROM public.draft_usage_tracking
WHERE organization_id = '<ORG_UUID>';

-- Per-model attribution. Meaningful from 20260819000003 onward; before that,
-- completed job rows carried provider = NULL, model = NULL.
SELECT provider, model, status, count(*)
FROM public.draft_generation_jobs
WHERE created_at > now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

`reserved_count` climbing while `draft_count` does not means reservations are being taken and not
consumed — jobs are failing after reserving. Look at `failed_jobs`.

**Are humans actually reviewing?** A rollout where drafts pile up unreviewed has not succeeded; it
has just created a queue.

```sql
SELECT d.status, count(*)
FROM public.ai_drafts d
WHERE d.organization_id = '<ORG_UUID>'
  AND d.created_at > now() - interval '24 hours'
GROUP BY 1;
```

Also worth reading directly, because it is the reviewers' actual verdict: a high `reject` rate in
`ai_draft_review_events`, or every approval preceded by an `edit`, means the drafts are not good
enough yet even though nothing is failing.

**Workers:**

```bash
systemctl is-active tugpt-draft-worker tugpt-whatsapp-worker
journalctl -u tugpt-draft-worker --since '1 hour ago' --no-pager | grep -i -E 'error|archiv|dead'
```

## 6. Expanding, and stopping

**Expand** one organization at a time, repeating §4 and §5 for each. Never enable a batch — with a
batch you learn that *something* broke, not *what*.

**Stop everything, instantly.** One statement, no deploy, no restart:

```sql
UPDATE public.feature_flags
SET is_enabled = false, updated_at = now()
WHERE organization_id IS NULL AND key = 'ai_draft_generation';
```

That is the kill switch. Every organization resolves `false` on the next evaluation. Verify:

```sql
SELECT count(*) AS still_enabled
FROM public.organizations o
WHERE o.deleted_at IS NULL
  AND public.is_feature_enabled(o.id, 'ai_draft_generation');   -- expect 0
```

Reach for the kill switch first and diagnose afterwards. Org rows can stay as they are; the global
`false` vetoes all of them, and leaving them in place means re-arming resumes exactly the previous
population — which is also the thing to remember before re-arming.

**Stop one organization** without affecting the others:

```sql
UPDATE public.feature_flags
SET is_enabled = false, updated_at = now()
WHERE organization_id = '<ORG_UUID>' AND key = 'ai_draft_generation';
```

In-flight jobs are unaffected either way: the flag is evaluated when a job is processed, so work
already in the queue drains under the old answer. Neither statement cancels anything already
generated, and neither deletes a draft.

## 7. What this procedure cannot do

It cannot send anything to a customer.

`whatsapp_integration` is enforced in two unrelated places (ADR-010, amendment §2). The WhatsApp
webhook — the only inbound path Meta can reach — reads a **hardcoded** value in
`packages/feature-flags/src/flags.ts`, not the database. Flipping the database row does not open the
webhook; only a reviewed code change going through CI does.

Two rules follow, and they are the point of this section:

- Do not read the database `whatsapp_integration` row as the state of the webhook. It is the state
  of everything *except* the webhook.
- Enabling outbound is a **two-key operation** — the code default *and* the database row — and both
  keys turn only with explicit owner approval, per the standing directive.

Until then, the end of the pipeline is a human clicking Approve in the dashboard. Nothing after
that step exists yet, which is exactly the intended state.
