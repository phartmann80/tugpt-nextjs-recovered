# ADR-004: RLS and Private Helper Functions

## Status
Accepted. **Amended 2026-08-20** — where the decisions below are actually
tested, and what was pretending to test them.

## Context
Supabase managed `auth` schema must remain untouched. Placing custom helper functions in public schema exposes them to PostgREST HTTP RPC calls unless explicitly restricted.

## Decision
1. Dedicated private schema: `CREATE SCHEMA IF NOT EXISTS private;`.
2. Public schema access revoked: `REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;`.
3. Security Definer helper functions:
   - `private.is_org_member(p_org_id, p_user_id)`
   - `private.get_user_org_role(p_org_id, p_user_id)`
   - `private.has_org_role(p_org_id, p_user_id, p_min_role)`
4. Hardened Security Definer config: All private functions declare `SECURITY DEFINER` and explicitly set `SET search_path = public, private, pg_temp` to eliminate search_path escalation vulnerabilities.
5. Mandatory RLS & Force RLS: Every business table (`profiles`, `organizations`, `organization_members`, `organization_invitations`, `audit_logs`, `feature_flags`) enables RLS (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`) and enforces RLS for table owners (`ALTER TABLE ... FORCE ROW LEVEL SECURITY;`).
6. Append-only Audit Logs: `public.audit_logs` permits `SELECT` and `INSERT` for organization members, but rejects all `UPDATE` and `DELETE` attempts.

## Consequences
- RLS checks execute safely without recursion or exposing internal query logic.
- Table owners and superusers cannot bypass RLS restrictions.

## Security Implications
- Prevents HTTP RPC exposure of internal helper routines.
- Immutability of audit logs ensures audit trail integrity.

---

## Amendment (2026-08-20): where this ADR is verified

Everything above is a claim about the database. It follows that it can only be
verified in a database, and it is: `supabase/tests/database/*.sql`, ~360 pgTAP
assertions, of which `rls_adversarial.test.sql` is the direct test of decisions
5 and 6 — it `SET ROLE`s to `authenticated`, injects JWT claims for a member of
tenant A, and asserts that tenant B's rows are not visible.

Two corrections were needed to make that statement true.

### 1. Those tests did not run

CI had `build-and-test` and `docker-build` and nothing else. No job invoked
`supabase test db`, so the suite had never executed automatically and had
drifted behind three migrations by the time it was first run. It is now the
`database-tests` job; procedure and conventions are in `docs/database-tests.md`.

The general shape of the mistake is worth naming, because it will recur: the
pnpm gate is thorough and green, and it covers the application. This system's
security is not in the application. A test suite that cannot fail is
indistinguishable from a document, and this one was being cited as evidence.

### 2. A TypeScript test claimed this ADR's guarantees and tested none of them

`packages/security/tests/rls-adversarial.test.ts`, titled "Adversarial Security
& Row-Level Isolation Tests", exercised a `PolicyEvaluator` class that answered
membership and role questions by scanning an array passed to it. It touched no
database, no policy, and no RPC. `PolicyEvaluator` had no consumer anywhere in
the repo — its only caller was that test.

Both were deleted. The reasoning, for the record: authorization here is enforced
by RLS and the `private.*` SECURITY DEFINER helpers named above. An exported
helper with a security-sounding name, no call sites, and a test asserting it
"prevents User A from accessing Tenant B resources" is worse than nothing — it
is a plausible thing for a future contributor to import and rely on, in place of
the enforcement that actually exists.

If an application-layer authorization helper is ever genuinely wanted, it should
be introduced with a consumer, and its tests should not claim to prove the
database's guarantees.
