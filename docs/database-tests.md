# The database test suite

**Status:** active
**Gate:** CI job `database-tests` in `.github/workflows/ci.yml`
**Files:** `supabase/tests/database/*.sql` — 24 files, ~430 pgTAP assertions

## Why this document exists

Until 2026-08-20 these files ran nowhere. CI had two jobs, `build-and-test`
(the pnpm gate) and `docker-build`, and neither invoked `supabase test db`. The
suite was written, committed, cited as evidence that the security model works —
and never executed by anything automatic.

That matters more here than it would in most codebases, because **TuGPT's
security model is almost entirely in the database.** RLS policies, the
`private.*` SECURITY DEFINER RPCs, the typed SQLSTATE contract, quota
reservation atomicity, queue visibility — none of it is expressible in
TypeScript, so none of it is covered by the pnpm gate. `pnpm test` passing tells
you the application code compiles and its units behave. It tells you nothing
about whether organization A can read organization B's drafts.

Turning the gate on found that the suite had drifted behind three migrations.
That is the argument for the gate, in one sentence.

## Running it

Requires Docker.

```bash
supabase db start      # pulls supabase/postgres, applies supabase/migrations, runs seed.sql
supabase test db --local
```

`supabase db start` is the database only — no API gateway, no auth server, no
studio. It is what pgTAP needs and nothing else. The Postgres major version
comes from `db.major_version` in `supabase/config.toml`.

To run one file while iterating:

```bash
supabase test db --local supabase/tests/database/rls_adversarial.test.sql
```

`supabase db reset` re-applies every migration from scratch against the running
container — use it after adding a migration rather than restarting.

## What the suite covers

| File | Guards |
|---|---|
| `rls_adversarial.test.sql` | cross-tenant reads/writes under real RLS, with `SET ROLE` and injected JWT claims |
| `rls_customer_facing_tables.test.sql`, `rls_operational_tables.test.sql` | RLS enabled, and the policy set, per table |
| `phase3b_permissions.test.sql`, `rpc_execution_permissions.test.sql`, `queue_wrapper_permissions.test.sql` | who holds EXECUTE on what — the grants that keep `anon`/`authenticated` out of the worker's RPCs |
| `phase3b_sqlstate.test.sql` | the P3B* error-code contract the worker and the API error mapper both depend on |
| `phase3b_store_archive.test.sql`, `phase3b_integrity.test.sql` | draft persistence, archival, and that `failed_jobs` carries no customer content |
| `phase3b_quota.test.sql` | reservation/consumption atomicity |
| `phase3b_schema.test.sql`, `phase3b_draft_rpc_wrappers.test.sql` | schema and function shape — the assertions that catch migration drift |
| `draft_attribution_and_audit.test.sql` | the 2026-08-19 migrations: provider-error detail and its 512-char backstop, the extended dead-letter allowlist, provider/model on the completed job row, review events append-only and surviving reviewer erasure, `applied_migration_versions` and its grants |
| `webhook_ingestion.test.sql`, `worker_processing.test.sql`, `queue_read_visibility.test.sql`, `dead_letter.test.sql`, `conversation_lifecycle.test.sql` | the inbound path and PGMQ semantics |
| `phase3b_feature_flag_rls.test.sql` | `is_feature_enabled` and its RLS |
| `invitations_and_ownership.test.sql` | membership lifecycle, double-acceptance protection |
| `conversation_activity_ordering.test.sql` | `conversations.activity_at` — that it falls back to `created_at`, that it is generated and unwritable, and that ordering on `last_message_at` still gives the wrong answer (the reason the column exists) |
| `ai_draft_config_defaults.test.sql` | that a config nobody wrote is Spanish and usable, that `business_instructions` stays empty because it has no true generic value, and that the backfill left written configs alone |
| `organizations_locale.test.sql` | the locale vocabulary: `organizations.locale` defaults to `es`, permits `en`, refuses anything else and is case-sensitive; the same for `profiles.preferred_locale` (ADR-017) |

## Writing a test

Every file is one transaction, rolled back:

```sql
BEGIN;
SELECT plan(<n>);
-- ... exactly n pgTAP assertions ...
SELECT * FROM finish();
ROLLBACK;
```

Three rules, each of which was broken by a file in this repo before the gate
existed:

1. **An assertion is a `SELECT` of a pgTAP function.** `SELECT ok(...)`,
   `SELECT is(...)`, `SELECT has_function(...)`. A bare
   `SELECT some_boolean AS ok_2, 'description' AS test_name;` looks like a test
   and is not one — it emits a result set, pg_prove reads TAP, and the line is
   silently ignored. It can never fail. `phase3b_draft_rpc_wrappers.test.sql`
   had twelve of these.
2. **`plan(n)` must equal the number of assertions**, and `finish()` must be
   present to report it when it does not. Two files were missing `finish()`.
3. **An exception aborts the transaction** and every remaining assertion in the
   file with it. `has_function_privilege('anon', 'public.f(int)', 'EXECUTE')`
   raises if `public.f(int)` does not exist — so a signature that drifts does
   not fail one assertion, it kills the file from that point on.

## When you add a migration

Assertions about schema shape live in `phase3b_schema.test.sql` and
`phase3b_draft_rpc_wrappers.test.sql`. If a migration changes a function
signature, adds a column, or changes nullability, update them in the same PR —
the gate will tell you, but only for the shape you already asserted. A new
column nobody asserts is a new column nobody tests.

Behaviour a migration introduces needs its own assertions, and those belong with
the concern rather than with the migration date.
`draft_attribution_and_audit.test.sql` is the example: it exists because the
three 2026-08-19 migrations shipped with none, which is how the older
shape assertions were free to drift behind them. If a new file is the right home,
add it to the table above so the suite stays legible.

Dropping and recreating a function to change its arity deserves a
`hasnt_function` assertion on the old signature as well as a `has_function` on
the new one. Otherwise a `CREATE OR REPLACE` that accidentally leaves the old
overload callable still passes.

## Known gap

The `database-tests` job runs but is **not yet a required status check** on
`main`. Adding it to branch protection is a repository-settings change; until it
is made, a red database suite does not block a merge.
