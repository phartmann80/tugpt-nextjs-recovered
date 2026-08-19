# ADR-010: Feature Flag Architecture

## Status
Accepted. **Amended 2026-08-19** — the original Decision 2 described the wrong evaluation
semantics. Read the amendment before relying on anything in the original text.

## Context
TuGPT.ai needs capability toggles for canary rollouts, tier-based feature gating (e.g. WhatsApp AI vs basic CRM), and multi-tenant flag overrides.

## Decision
1. Feature Flag Entity: `public.feature_flags` table storing:
   - `key`: Unique flag identifier string.
   - `is_enabled`: Boolean toggle. *(The original text said `enabled`; the column is `is_enabled`.)*
   - `organization_id`: Nullable. `NULL` denotes the global row; a UUID denotes the org row.
   - `description`: Explanatory text.
2. Flag Evaluation: `public.is_feature_enabled(p_organization_id, p_flag_key)` is the source of
   truth. **It is a logical AND of the global row and the org row — not an override chain.** See
   the amendment below; the original wording ("Evaluates organization-specific override first,
   falls back to global") describes behaviour that does not exist.
3. Access Control: Feature flag definitions are readable by authenticated members, but writable
   only by platform superusers / admins. `is_feature_enabled` itself is `service_role` only —
   `EXECUTE` is revoked from `anon` and `authenticated`.

## Consequences
- Dynamic feature activation without code redeployments — **for flags read through
  `is_feature_enabled`**. See the amendment for the one flag where this is not true.
- Multi-tenant customization support.

## Security Implications
Prevents unauthorized access to unreleased features or restricted enterprise capabilities.

---

## Amendment (2026-08-19): what the flags actually do

Two corrections, both found while enabling `ai_draft_generation` for a single organization during
the milestone-1 run. Both matter for controlled rollout, so they are recorded here rather than in a
runbook.

### 1. Evaluation is an AND, not an override

`public.is_feature_enabled` (migration `20260805000013`) is, in full:

```sql
SELECT COALESCE(
  (SELECT is_enabled FROM public.feature_flags
   WHERE organization_id IS NULL AND key = p_flag_key)
  AND
  COALESCE(
    (SELECT is_enabled FROM public.feature_flags
     WHERE organization_id = p_organization_id AND key = p_flag_key),
    false
  ),
  false
);
```

Both sides must be true. The consequences are worth stating plainly, because they are the opposite
of what "organization-specific override" implies:

| Global row | Org row | Result |
|---|---|---|
| `true` | `true` | **enabled** |
| `true` | `false` | disabled |
| `true` | missing | disabled |
| `false` | `true` | **disabled** — the org row cannot override |
| `false` | anything | disabled |
| missing | anything | disabled |

So:

- **You cannot pilot a feature for one organization while the global row stays `false`.** Enabling
  it anywhere requires setting the global row to `true`. This was assumed to be possible when
  planning milestone #1 and is not.
- **Tenant isolation is still exact.** With the global row `true`, every organization that has no
  org-scoped row resolves to `false` — the inner `COALESCE(..., false)`. Turning the global row on
  does not turn the feature on for anyone; it only stops the global row from vetoing.
- **The global row is a kill switch.** Setting it to `false` disables the feature for every
  organization in one statement, with no deploy. This is the property to reach for in an incident.

The org row is therefore an **allowlist entry**, and the global row is an **arming switch**. That
framing predicts the truth table; "override" does not.

Rollout procedure built on this: `docs/controlled-rollout.md`.

### 2. `whatsapp_integration` is enforced in two unrelated places, and only one is the database

There are two flag systems in this codebase, and they do not talk to each other.

| | Source of truth | Consulted by | Changing it |
|---|---|---|---|
| Database flags | `public.feature_flags` via `is_feature_enabled` | draft worker (`apps/worker/src/draft-worker.ts`), draft review APIs (`apps/web/src/lib/draft-api/feature-gate.ts`) | SQL statement, effective immediately |
| In-memory flags | `FeatureFlagService` in `packages/feature-flags/src/flags.ts` — **hardcoded defaults, never reads the database** | the WhatsApp webhook route (`apps/web/src/app/api/v1/webhooks/whatsapp/route.ts`), which returns 404 on GET and POST when the flag is off | **code change and redeploy** |

The webhook — the only inbound entry point Meta can reach — checks
`featureFlagService.isEnabled('whatsapp_integration')`, whose value is the literal `false` compiled
into `flags.ts`. **Flipping the `whatsapp_integration` row in the database does not open the
webhook.**

This is recorded, not "fixed", because in the off direction it is the safer arrangement: outbound
WhatsApp cannot be turned on by anyone with database write access, only by a reviewed code change
going through CI. Given that enabling outbound customer messaging requires explicit owner approval,
a second independent gate that a SQL statement cannot lift is a feature.

What it must not become is a surprise. Two rules follow:

- **Do not read the database `whatsapp_integration` row as the state of the webhook.** It is the
  state of everything *except* the webhook. The milestone-1 harness asserts on the database row
  because its concern is that no code path it exercises can send; that is a different question.
- **Enabling outbound is a two-key operation** — the code default in `flags.ts` *and* the database
  row — and both keys turn only with owner approval.

If the two are ever unified, the in-memory service must be the side that changes (reading
`is_feature_enabled`), never the webhook being pointed at the database while `flags.ts` keeps a
hardcoded default that disagrees with it.
