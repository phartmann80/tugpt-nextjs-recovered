# Phase 2 Release Gate — Status Report

Branch: `hotfix/phase2-release-gate`
Scope of this document: ESLint 9 flat-config correction and the verification
evidence personally executed to support it. This document only records
evidence confirmed by direct command execution or direct file inspection in
this session — nothing is carried over from prior, uncommitted reports.

Legend used below:
- **Verified** — a command was executed in this session and its exit code /
  output was inspected.
- **Structurally inspected, execution pending** — the file/config was read
  and its structure checked, but it has not been run end-to-end.
- **Blocked by environment** — could not be executed due to a sandbox
  limitation, not a defect in the repository.
- **Pending verification** — not yet attempted.

## 1. ESLint 9 flat configuration

**Verified.**

Root cause: only `apps/web/eslint.config.mjs` existed. ESLint 9 has no
fallback config resolution, so every `packages/*` package's `"lint": "eslint
."` script failed immediately with "no config found."

Change made:
- `eslint.config.mjs` (repo root) — new shared flat config for the TypeScript
  library packages, built from `typescript-eslint` (`tseslint.config`) plus
  `@eslint/js` recommended rules and `globals.node`. Ignores
  `node_modules/**`, `dist/**`, `.turbo/**`, `.next/**`, `build/**`,
  `coverage/**`.
- `packages/*/eslint.config.mjs` (7 files) — thin re-exports of the root
  config, required so `eslint .` resolves correctly when Turbo runs each
  package's `lint` script with that package directory as the working
  directory.
- `apps/web/eslint.config.mjs` — **unchanged**, keeps its Next.js-specific
  config (`eslint-config-next` core-web-vitals + typescript configs).
- No source or test directories were excluded from linting. No blanket
  `eslint-disable` comments were added. No recommended rule sets were
  broadly disabled.

**Genuine finding fixed:** `packages/observability/tests/logger.test.ts`
imported `defaultLogger` from `../src/logger` but never used it. The dead
import was removed (not suppressed).

**Dependencies:** `eslint@9.39.5`, `typescript-eslint@8.64.0` (with its
transitive `@typescript-eslint/eslint-plugin`/`parser@8.64.0`),
`@eslint/js@9.39.5`, and `globals@16.4.0` were already resolved in
`pnpm-lock.yaml` via `apps/web`'s dependency tree and hoisted into the root
`node_modules` (`shamefully-hoist=true` in `.npmrc`). **No new packages were
installed.** The root `package.json` now declares these as explicit
`devDependencies` (they were previously only transitive/hoisted, which is
fragile), which added 12 lines to `pnpm-lock.yaml` — all additive, no
existing resolved version changed. No npm or Yarn lockfile was introduced.

**Result:** `pnpm exec turbo run lint --force` → exit 0, 8/8 packages
passing, 0 errors, 0 warnings, cache bypassed (see §6 for full run evidence).

## 2. ADR-006 / adapter contract consistency

**Verified (documentation/comment correction only — no implementation
change).**

- `docs/adr/ADR-006-provider-adapter-architecture.md` — Status remains
  **Provisional**. Corrected the "Decision" section, which previously
  described `generateText`, `streamText`, and `generateEmbedding` — none of
  which are implemented. It now accurately states the adapter currently
  exposes only `generateCompletion`, and lists the full capability set that
  still requires a dedicated review (chat, streaming, structured output,
  tool-call requests, embeddings, image generation, video jobs,
  speech-to-text, text-to-speech, cancellation, timeouts, retry policy, error
  normalization, usage/cost reporting, model-level capability discovery). It
  explicitly states application tools must be executed by the orchestration
  layer, not the provider adapter.
- `packages/ai-providers/src/adapter.ts` — the file/interface comments
  previously called the contract "frozen." Corrected to state the interface
  is provisional, covers only `generateCompletion`, and must not be treated
  as final until the capability review referenced in ADR-006 happens.
- **No adapter code, method signatures, or provider implementations were
  changed.** This was a documentation/comment-only correction, as scoped.

## 3. Toolchain version reproducibility

**Verified (report only — no dependency versions changed).**

Exact versions currently resolved in `pnpm-lock.yaml`:

| Root manifest specifier | Resolved version |
|---|---|
| `turbo: "latest"` | `2.10.5` |
| `supabase: "^2.109.1"` | `2.109.1` |
| `typescript: "^5.4.5"` | `5.9.3` |

**Proposal (not applied — awaiting your decision):**
- `turbo: "latest"` should be pinned to an exact version (`"2.10.5"`). As
  written, every fresh `pnpm install` on a machine without a matching
  lockfile entry can silently pick up a newer Turbo release, which changes
  cache behavior/CLI flags without anyone deciding to upgrade.
- `supabase: "^2.109.1"` — a caret range allows automatic minor/patch bumps
  of the CLI. Given the CLI drives migrations and pgTAP execution, I'd
  recommend pinning this exactly too (`"2.109.1"`), so a `pnpm install`
  never changes what CLI version runs migrations without an explicit
  decision.
- `typescript: "^5.4.5"` resolving to `5.9.3` is a wide gap (minor-version
  drift). Recommend re-pinning to the version actually in use (`"5.9.3"`) so
  the manifest reflects reality, or deliberately deciding to downgrade if
  `5.4.5` was intentional.

I have **not** applied any of these changes — they require your explicit
go-ahead since you asked that lockfile changes be intentional and reported,
and this is a scope decision (toolchain pinning) beyond the lint fix itself.

## 4. pgTAP inventory

```text
File 1: supabase/tests/database/rls_adversarial.test.sql — plan 35 — 35 assertions
File 2: supabase/tests/database/invitations_and_ownership.test.sql — plan 10 — 10 assertions
Expected total: 45
```

Both files' `plan(N)` declarations match their actual assertion counts
(counted via direct grep of pgTAP assertion functions: `ok`, `is`, `isnt`,
`throws_ok`, `results_eq`, `is_empty`, `matches`, `cmp_ok`, `lives_ok`,
`isa_ok`, `has_column`, `hasnt_column`, `col_type_is`, `policies_are`,
`policy_cmd_is`). This was a **structural** check only in this sandbox (no
running Postgres instance available here — see §6).

**Real execution result, from Paul's Windows machine (Docker Desktop,
`pnpm exec supabase db reset` + `pnpm exec supabase test db`):**

```text
supabase db reset: verified passing
rls_adversarial.test.sql: verified passing, 35 assertions
invitations_and_ownership.test.sql: parser failure after 8 assertions
Phase 2 database gate: not yet passed
```

The failure was a genuine defect, not a false negative: a SQL parser error
(`syntax error at or near "$"`) at line ~204 of
`invitations_and_ownership.test.sql`, Test 7a. The original code used the
same `$$` dollar-quote tag for both the outer pgTAP string literal and the
inner `DO` block body:

```sql
SELECT lives_ok(
  $$DO $$$
  ...
  $$$$,
  ...
);
```

Postgres's tokenizer closes a dollar-quoted string at the **first** matching
tag, so the outer `$$` was terminated by the inner `DO $$`'s tag, corrupting
the rest of the statement.

**Fix applied** (`supabase/tests/database/invitations_and_ownership.test.sql`,
Test 7, this session): switched to distinct tagged delimiters — `$statement$`
wrapping the pgTAP argument, `$block$` wrapping the `DO` block body — so the
two cannot collide. While reviewing the block semantically (not just for the
parser fix), a second, real issue was found and corrected: the original
`EXCEPTION WHEN OTHERS THEN NULL;` would silently swallow *any* error inside
the block, including an unrelated bug (e.g. a broken `INSERT`), and let the
test pass for the wrong reason. Narrowed to `WHEN SQLSTATE 'P0001'` — the
specific code `private.prevent_last_owner_removal()` raises (a bare `RAISE
EXCEPTION` with no explicit SQLSTATE defaults to `P0001`, matching every
other `throws_ok()` assertion in this file) — so anything else now correctly
re-raises and fails the test instead of being hidden.

Semantic review performed against this fix (structural only, not yet
re-executed — see below):
1. The ownership-protection exception is expected to fire: at that point in
   the test, User B (`22222222-...`) is the organization's sole owner
   (established by Tests 4-5), so the `UPDATE ... SET role='admin'` on B
   triggers `private.prevent_last_owner_removal()`, which raises `P0001`.
2. The narrowed handler no longer masks unrelated errors.
3. PL/pgSQL's implicit exception-block subtransaction rolls back everything
   since `BEGIN`, including the preceding valid `INSERT`, once the exception
   is caught.
4. Test 7b's expectation of a zero member count for that row is therefore
   correct and unchanged.
5. Assertion count confirmed unchanged: `plan(10)` and exactly 10 pgTAP
   assertion calls (`grep`-counted after the edit).
6. No production migration or RLS policy/function was changed — only the
   test file. `private.prevent_last_owner_removal()` in
   `supabase/migrations/20260716000001_initial_schema.sql` is untouched.

**This fix has NOT been re-executed against a live Postgres instance in this
sandbox** (same Docker/network limitation as before). Per your explicit
instruction, this test is **not** claimed as passing. It is:

```text
invitations_and_ownership.test.sql: fix applied, re-execution pending on Paul's machine
Phase 2 database gate: not yet passed — awaiting Paul's re-run
```

**Commands to re-run on Paul's Windows machine** (PowerShell or Git Bash,
from the repo root, with Docker Desktop running):

```powershell
pnpm install --frozen-lockfile
pnpm exec supabase start
pnpm exec supabase db reset
pnpm exec supabase test db
```

`supabase db reset` re-applies `supabase/migrations/*.sql` and
`supabase/seed.sql` against the local Postgres container. `supabase test db`
then runs every `*.test.sql` file under `supabase/tests/database/` through
pgTAP and reports pass/fail per assertion.

### Second real execution (Windows, after the dollar-quote fix)

The dollar-quote parser fix above was confirmed to resolve the original
parser error: Test 7 now executes as valid SQL. A second, distinct defect
then surfaced — this is a genuine test-fixture bug, not a false negative:

```text
Parser defect: fixed and confirmed resolved
Second execution:
- rls_adversarial.test.sql: 35/35 pass
- invitations_and_ownership.test.sql: 8/10 pass
- Test 7a failed with 23505 because User C already existed from Test 3
- Test 7b observed that existing User C row
Phase 2 database gate: still pending
```

**Root cause:** Test 3 calls `accept_invitation()` for User C
(`33333333-...`), which creates a real `organization_members` row for User C.
Test 7a's `DO` block then attempted to `INSERT` a *second* membership row for
that same `(organization_id, user_id)` pair, which Postgres correctly
rejected with `23505` (unique violation) — before the block ever reached the
intended `UPDATE` that should trigger `P0001`. Because the `INSERT` never
committed, the DO block's exception handler was never exercised as designed.
Test 7b then counted User C's real, pre-existing membership row (1), not a
rolled-back one (0), so it failed too. The `WHEN SQLSTATE 'P0001'` handler
from the previous fix was correct and untouched by this change — the defect
was a test-fixture collision, not a handler problem.

**Fix applied (this session):** added a fourth test user, User D
(`44444444-4444-4444-4444-444444444444`, `rollback_d@tugpt.ai`), seeded into
`auth.users` and `public.profiles` only — deliberately **not** added to
`organization_members` during setup. Test 7a's `INSERT` and Test 7b's count
assertion now both target User D instead of User C, so the test begins with
a genuinely absent membership row, guaranteeing the `INSERT` succeeds
initially and the rollback assertion is real.

Semantic review performed against this fixture fix:
1. User D exists as a profile but has no organization membership before
   Test 7 (confirmed: absent from the setup `organization_members` seed).
2. The User D insert succeeds initially (no unique-constraint collision,
   since the row is genuinely new).
3. The subsequent `UPDATE` on sole-owner User B still raises `P0001`,
   unchanged from the previous fix.
4. Catching that exception rolls back the User D insert within the
   PL/pgSQL exception subtransaction (same mechanism as before).
5. Test 7b verifies the rollback by finding zero User D memberships —
   this is now a real assertion of rollback behavior, not an artifact of a
   pre-existing row.
6. User C's Test-3 membership is untouched — Test 7's block never
   references User C's id.
7. `plan(10)` and exactly 10 pgTAP assertions confirmed unchanged
   (`grep`-counted after the edit).
8. No production migration, trigger, constraint, function, or RLS policy
   was changed — only the test file. `private.prevent_last_owner_removal()`
   and the `organization_members` unique constraint are both untouched.

**This fixture fix has NOT been re-executed against a live Postgres instance
in this sandbox** (same Docker/network limitation as before). It is:

```text
invitations_and_ownership.test.sql: fixture fix applied, re-execution pending on Paul's machine
Phase 2 database gate: still pending — awaiting Paul's next re-run
```

The same command bundle above (`supabase start` / `db reset` / `test db`) is
the only way to confirm this fix resolves the `23505` collision and all 45
assertions pass.

## 5. Missing implementation-plan artifacts

**Confirmed:** `implementation_plan.md` and `walkthrough.md` do not exist in
the working tree, in `git log --all`, or on any branch. Not blocking this
work, per your instruction. This document (`docs/status/PHASE_2_RELEASE_GATE.md`)
is the authoritative, personally-verified replacement for Phase 2 status —
no content was copied from any prior, unverified report.

## 6. Secrets-report file

**Verified.** `secrets_report.json` was committed empty (0 bytes, git's
empty-blob hash) in the very first consolidation commit of this repository
and has never contained content in its history. Nothing in the
repository — no CI workflow, no script, no documentation — references or
regenerates this filename. It is stray/generated tool output, not a required
source artifact.

Action taken:
- Removed from version control (`git rm --cached secrets_report.json`).
- Added `secrets_report.json` to `.gitignore` under a "generated
  secret-scanning report" comment.
- Documenting the scan command here instead of committing its output. No
  secret-scanner is currently installed or configured in this repo. The
  recommended command (run locally, output stays untracked):

```bash
# from repo root, requires gitleaks installed locally
gitleaks detect --source . --report-path secrets_report.json
```

No secret values were printed or exposed as part of this investigation.

## 7. Fresh verification results (this session)

All four commands were run via `pnpm exec turbo run <task> --force` to
bypass Turbo's cache and force real execution, immediately after
`pnpm install --frozen-lockfile` succeeded (exit 0).

| Command | Exit code | Duration | Packages executed | Cached? |
|---|---|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | ~3s | all 9 workspace projects | n/a (install) |
| `pnpm exec turbo run lint --force` | 0 | 3.84s | 8/8 (`ai-providers`, `auth`, `database`, `feature-flags`, `jobs`, `observability`, `security`, `web`) | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run typecheck --force` | 0 | 4.50s | 8/8 (same set) | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run test --force` | 0 | 1.79s | 5/5 (`auth`, `database`, `observability`, `security`, `web` — the only packages with a `test` script) | 0 cached / 5 total — all force-executed |
| `pnpm exec turbo run build --force` | 0 | 9.14s | 1/1 (`web` — the only package with a `build` script) | 0 cached / 1 total — force-executed |

**Test files and assertion totals** (from the `test` run above):

| Package | Test file | Assertions |
|---|---|---|
| `web` | `tests/app-config.test.ts` | 3 |
| `web` | `src/proxy.test.ts` | 8 |
| `web` | `src/app/api/v1/routes.test.ts` | 8 |
| `auth` | `src/service.test.ts` | 5 |
| `database` | `src/client.test.ts` | 10 |
| `observability` | `tests/logger.test.ts` | 5 |
| `security` | `tests/rls-adversarial.test.ts` | 6 |

**Total: 7 test files, 45 assertions, all passing.**

**Warnings:** none emitted by `lint`, `typecheck`, `test`, or `build` in any
package during these runs.

### Supabase (§4 commands)

**Blocked by environment in this sandbox**, not by the repository:
`pnpm exec supabase db reset` and `pnpm exec supabase test db` require a
multi-container Docker Compose–style stack (Postgres, GoTrue, Kong,
Realtime, Storage, etc.). In this sandbox, Docker itself runs and single
containers work (`docker run hello-world` succeeds), but the daemon cannot
bind-mount container network namespaces (`permission denied` on
`/proc/.../ns/net`) needed to network the Supabase container stack together.
This was confirmed directly, is a sandbox infrastructure restriction, and I
did not repeatedly retry or leave containers/networks in a broken state —
everything was cleaned up (`docker ps -a` is empty, working tree is clean).

**Real execution did happen — on Paul's Windows machine, not this sandbox.**
See §4 for the full result: `supabase db reset` passed, `rls_adversarial.test.sql`
passed 35/35, `invitations_and_ownership.test.sql` failed with a SQL parser
error after 8/10 assertions. The fix for that failure is recorded in §4; it
has been structurally reviewed but **not yet re-executed** — the database
gate remains **not yet passed** until Paul re-runs it and confirms.

## 7b. Post-fix verification (this session — Test 7 dollar-quote / exception-handler correction)

Same fresh, forced (non-cached) commands re-run after the
`invitations_and_ownership.test.sql` fix described in §4. `build` was not
re-run in this pass since nothing affecting `web`'s build changed.

| Command | Exit code | Duration | Packages executed | Cached? |
|---|---|---|---|---|
| `pnpm exec turbo run lint --force` | 0 | 3.72s | 8/8 | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run typecheck --force` | 0 | 3.93s | 8/8 | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run test --force` | 0 | 1.67s | 5/5 (7 test files) | 0 cached / 5 total — all force-executed |

**Total: 7 test files, 45 JS/TS assertions, all passing.** (This is the same
JS/TS suite as §7 — the `.test.sql` fix only touches the pgTAP file, which
this sandbox cannot execute; see above.) No warnings emitted by any command.

## 7c. Post-fixture-fix verification (this session — Test 7 User-D fixture correction)

Same fresh, forced (non-cached) commands re-run after the User D test-fixture
fix described in §4 ("Second real execution"). `build` was not re-run in this
pass since nothing affecting `web`'s build changed.

| Command | Exit code | Duration | Packages executed | Cached? |
|---|---|---|---|---|
| `pnpm exec turbo run lint --force` | 0 | 4.01s | 8/8 | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run typecheck --force` | 0 | 4.26s | 8/8 | 0 cached / 8 total — all force-executed |
| `pnpm exec turbo run test --force` | 0 | 1.625s | 5/5 (7 test files) | 0 cached / 5 total — all force-executed |

**Total: 7 test files, 45 JS/TS assertions, all passing.** Same caveat as
§7b: this is the JS/TS suite only. The pgTAP fixture fix itself has not been
re-executed in this sandbox and is not claimed as passing — see §4 for the
exact re-run commands for Paul's Windows machine.

## 8. Commit

See the accompanying diff and commit hash reported separately. Nothing in
this change touches `main`, creates a tag, deploys anything, or modifies any
hosted Supabase project.
