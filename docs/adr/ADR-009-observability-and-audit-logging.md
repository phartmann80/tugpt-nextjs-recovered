# ADR-009: Observability and Audit Logging

## Status
Accepted. Amended 2026-08-19 — see "Amendment: the audit boundary".

## Context
Production compliance requires structured log telemetry and immutable audit logging for security events (login, organization creation, role changes, data modifications).

## Decision
1. Application Telemetry: `@tugpt/observability` provides `Logger` generating structured JSON records (`timestamp`, `level`, `message`, `context`, `error`).
2. Performance & Latency: `MetricsCollector` records latency metrics, execution durations, and AI token counts.
3. Database Audit Logging: `public.audit_logs` table stores:
   - `id`, `organization_id`, `user_id`, `action`, `resource`, `details` (jsonb), `ip_address`, `created_at`.
4. Append-Only Enforcement: `authenticated` holds only `SELECT` and `INSERT` on `audit_logs`; there is no `UPDATE` or `DELETE` grant for any application role, and `trigger_prevent_audit_log_modification` raises on `UPDATE` or `DELETE` as a backstop. RLS is FORCED, and `SELECT` is further restricted to `owner` / `admin` / `manager`.
5. Secret Redaction in Logs: The `Logger` sanitizes all context values via `sanitizeValue()`, which redacts:
   - Values whose key matches sensitive patterns (`password`, `secret`, `token`, `authorization`, `api_key`, `cookie`, `private_key`, `service_role_key`, `credential`).
   - Inline Bearer tokens (`Bearer\s+[A-Za-z0-9-_.=]+`) in string values.
   - API keys (`sk-...`, `sbp_...`) in string values.
6. Error Message Sanitization: As of PR #2, `err.message` is also passed through `sanitizeValue()` before being included in the log payload. Previously, error messages were logged raw, which could leak secrets if an error message contained a token or key value.

## Consequences
- Guaranteed audit trail for forensic investigation.
- Real-time observability formatted for cloud logging aggregators (Datadog, GCP Cloud Logging).
- Secrets in error messages are now redacted alongside secrets in context values, preventing accidental leakage through thrown errors.

## Security Implications
Audit trail cannot be tampered with or deleted by malicious organization admins or compromised user accounts.
Secrets in error messages are now treated with the same redaction as secrets in context values.

---

## Amendment: the audit boundary (2026-08-19)

### Why this was ambiguous

The Context above says audit logging covers "data modifications". The milestone-1
evidence pack then showed `auditLogs: []` for a run in which a draft had been
edited and approved by a real reviewer — which reads as a missing audit trail.

It is not missing. It is in a different table, and that was never written down.

Two corrections of fact, both verified against the schema rather than assumed:

- `public.audit_logs` has exactly **two** writers, both in
  `20260716000001_initial_schema.sql`: `create_organization` writes
  `'organization.create'` (line 237) and `accept_invitation` writes
  `'invitation.accept'` (line 302). Nothing else in the codebase inserts into it.
- The column is `user_id`, not `actor_id`. Decision 3 above said `actor_id` and
  has been corrected.

So "data modifications" was aspirational. The two tables have simply grown apart
without anyone saying which is responsible for what.

### The decision

**Human review of AI drafts — approve, edit, reject — is recorded in
`public.ai_draft_review_events`, and that table is the audit record of those
actions. It is not mirrored into `audit_logs`.**

Reasons, in order of weight:

1. **One record, not two.** Writing each review action to both tables creates
   two sources of truth for the same event. They will diverge — one write
   succeeding while the other is rolled back, one schema evolving without the
   other — and at that point neither can be trusted for forensics, which is the
   whole point of having them.
2. **The domain table says more.** `ai_draft_review_events` carries
   `previous_version` and `new_version`, which is what makes an optimistic-locking
   dispute reconstructable. `audit_logs.details` could hold the same as loose
   JSON, unconstrained and unindexed. It also carries a composite foreign key
   `(organization_id, draft_id) -> ai_drafts(organization_id, id)`, so an event
   belonging to its draft's organization is a structural guarantee rather than
   something the writer has to get right.
3. **The dashboard already reads it.** The review-history UI reads
   `ai_draft_review_events`. Adding an `audit_logs` mirror would produce rows
   nothing reads, which is how audit tables rot.

`audit_logs` keeps organization and membership lifecycle: who created an
organization, who accepted an invitation, and — when they are built — role
changes and organization-level setting changes. Those are cross-cutting and have
no domain table of their own.

### What the decision obliged us to fix

Declaring a table the audit record of something means it has to behave like one.
Two gaps, both closed in `20260819000003`:

| Gap | Before | After |
|---|---|---|
| Append-only | Implied by the absence of `UPDATE`/`DELETE` grants — an omission, not a decision, and one that a future `GRANT ALL` would quietly undo | Explicit `REVOKE UPDATE, DELETE` and a table comment stating it |
| `actor_id` | `NOT NULL` **and** `ON DELETE SET NULL` — a contradiction. Deleting any profile that had ever reviewed a draft failed with `null value in column "actor_id" ... violates not-null constraint`, which would have blocked offboarding and GDPR erasure | Nullable, matching `audit_logs.user_id`. Every writer is a `SECURITY DEFINER` RPC passing `auth.uid()`, so `NULL` means "actor since erased" and nothing else |

### Deliberately not done, and why

Two changes that look obviously right were considered and rejected. Both are
recorded here because their absence otherwise reads as an oversight, and the
next person will reach for them.

**No immutability trigger** like `audit_logs` has. Both of this table's foreign
keys are `ON DELETE CASCADE`, so a trigger that raises on `DELETE` would make
deleting a draft or an organization fail outright — including the erasure paths
we are required to keep working, and the test-suite cleanup that deletes drafts
today. `audit_logs` gets away with the trigger only because organizations are
soft-deleted by `trigger_soft_delete_organizations`, so its cascade never fires.

**No `FORCE ROW LEVEL SECURITY`**, despite `profiles`, `audit_logs`,
`feature_flags` and `draft_generation_jobs` all being `FORCE`D. Verified on
PostgreSQL 16.13 rather than reasoned about:

- It would buy nothing. `FORCE` changes behaviour only for the table owner, and
  the owner holds `BYPASSRLS`, so RLS is skipped for it either way.
- It would break the write path without an added permissive `INSERT` policy —
  and, the moment any writer used `RETURNING`, a permissive `SELECT` policy too,
  because PostgreSQL evaluates the `SELECT` policy for the `RETURNING`
  read-back. It reports that failure as `new row violates row-level security
  policy`, which reads like a `WITH CHECK` failure and sends you looking in the
  wrong place entirely. (The current review RPCs do not use `RETURNING` on this
  insert — but nothing stopped them from starting to.)
- That `SELECT` policy could not be scoped to the definer, so it would have to
  be permissive to `PUBLIC` — letting any authenticated session read every
  organization's review events. **Tenant isolation is worth more than schema
  symmetry.**

In both cases the protection that actually matters is identical to what
`audit_logs` has: no application role holds `UPDATE` or `DELETE`. A trigger or a
`FORCE` flag only adds defence against a connection privileged enough to remove
them.

### Reading the evidence pack

`auditLogs: []` in a milestone-1 evidence pack is **expected** and is not a
finding. A milestone-1 run creates no organization and accepts no invitation, so
it writes no `audit_logs` row. The draft audit trail for that run is in
`reviewEvents`. The evidence pack now says so inline, and asserts that an
approved or rejected draft has at least one review event — so a genuinely
missing trail fails the run instead of being read past.
