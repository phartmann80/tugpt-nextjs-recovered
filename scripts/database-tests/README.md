# Local database harness

**This is an approximation of CI. It is not a gate.**

CI runs `supabase db start` — a real Supabase Postgres image — and then
`supabase test db --local`. That job, on a named commit, is the only thing that
counts as green. The scripts in this directory hand-build a lookalike so the
pgTAP suite can be run in seconds without Docker. Where the two disagree, CI is
right and this is wrong.

## Why that warning is at the top

On 2026-09-03 this harness reported green on six consecutive pull requests
whose `database-tests` job was failing. Two defects, both invisible here:

**A migration granted a subset and revoked nothing.** Supabase initialises a
project with `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
... service_role`, so every table is *created* with ALL already granted. The
encrypted-credential tables therefore kept `TRUNCATE` and `TRIGGER` for
`service_role`, which the migration's own comment said they must not have. This
harness created its roles by hand and never set those default privileges, so
the table came out with exactly what the migration granted and the assertion
that would have caught it passed.

That one is worth understanding rather than just patching around: **RLS does not
apply to TRUNCATE.** A role with TRUNCATE can empty a table it cannot read a
single row from. Row-level policies are not a backstop for a table-level grant.

**A test sorted by the server's collation.** Under `C` the sort is by byte, so
`-` (0x2D) precedes `.` (0x2E) and `gpt-5-mini` comes before `gpt-5.1`. Under
glibc `en_US.UTF-8` punctuation is ignored at the primary level, the keys
compare as `gpt51` against `gpt5mini`, and `gpt-5.1` comes first. Identical
values, different order, three pull requests red. This harness created its
databases with no locale clause at all.

Both gaps are now closed in `reset_db.sh`, and `reset_db.test.sh` asserts they
stay closed. Both failures reproduce here before the fix and pass after it.

## What this still does not replicate

Not an exhaustive list — that is the point. If something passes here and fails
in CI, assume this list is incomplete rather than that CI is flaky.

- **PostgREST.** Grants and RLS are exercised by `SET ROLE`, not by a real API
  request carrying a JWT.
- **GoTrue.** `auth.users` is a hand-written table with the columns the suite
  happens to touch, and `auth.uid()` / `auth.role()` are stubs.
- **Extension versions.** `pgmq`, `pgcrypto` and `pgtap` come from whatever the
  local cluster has, not from the pinned Supabase image.
- **Supabase's own schemas and roles** beyond the three this creates —
  `supabase_admin`, `authenticator`, storage, realtime.
- **Anything Supabase adds in a future CLI release.** The CI job pins the CLI
  version deliberately; this directory tracks it by hand, which means it drifts.

## Usage

```sh
sh scripts/database-tests/run_all_tests.sh     # reset, migrate, run pgTAP
sh scripts/database-tests/reset_db.sh          # reset only
sh scripts/database-tests/reset_db.test.sh     # test the harness itself
```

`reset_db.test.sh` needs no database and no network. It runs in CI beside the
other fixture tests, because a harness nobody tests is the same failure one
level up — which is precisely what this directory turned out to be.
