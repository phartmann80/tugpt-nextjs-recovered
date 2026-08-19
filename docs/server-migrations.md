# Applying database migrations from the server

**Status:** active procedure
**Applies to:** `212.227.44.13`, checkout at `/opt/tugpt`
**Staging project ref:** `rbiumegrwtavmljxbknp`

---

## 0. Why this document exists

On 2026-08-19 the first end-to-end milestone-1 run completed and reported
success against a staging database that was **missing migration
`20260819000001`**. `pnpm exec supabase db push` had failed on the server with:

```
Cannot find project ref. Have you run supabase link?
```

Nothing downstream treated that as fatal. The harness printed
`[WARN] could not read failed_jobs: column provider_error_detail does not exist`
and carried on to a green result.

Two things came out of that:

1. This document — one procedure, no linking step, no interactive prompts.
2. A hard gate in the harness preflight (§4). It now refuses to run when the
   checkout contains migrations the database does not have.

---

## 1. Recommended: push with an explicit connection string

`supabase db push --db-url` bypasses `supabase link` entirely. Nothing is
stored in `supabase/.temp/`, no Supabase **access token** is needed, and there
is no interactive prompt — which is what makes it the right choice for a
headless box.

```bash
cd /opt/tugpt
set -a; . /etc/tugpt/migrate.env; set +a

# Always look before you leap.
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run

# Apply.
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
```

`--dry-run` prints the migrations that *would* be applied. If it prints
nothing, the database is already current; if it prints something unexpected,
stop and read §6 before applying.

### 1.1 The credential file

Create `/etc/tugpt/migrate.env`, alongside the existing `worker.env` and
`web.env`:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/tugpt/migrate.env
sudo tee /etc/tugpt/migrate.env >/dev/null <<'EOF'
# Database owner connection string for schema migrations.
# NOT read by any service. Used only by an operator running `supabase db push`.
SUPABASE_DB_URL='postgresql://postgres.rbiumegrwtavmljxbknp:PASSWORD@POOLER_HOST:5432/postgres'
EOF
```

Deliberately a separate file from `worker.env` / `web.env`: the workers must
never hold a credential that can alter the schema. Nothing loads
`migrate.env` at boot; no systemd unit references it.

**Root-owned, mode 0600.** It holds the database owner password.

### 1.2 Filling in the two placeholders

Both come from the Supabase dashboard →
**Project Settings → Database → Connection string → URI**:

| Placeholder | Where it comes from |
|---|---|
| `POOLER_HOST` | The host in the **Session pooler** URI, e.g. `aws-0-<region>.pooler.supabase.com`. The region is project-specific — copy it, don't guess. |
| `PASSWORD` | The database password. Not the anon key, not the service-role key, not a personal access token. If nobody has it, use **Reset database password** on that page. |

Two rules that cause most first-attempt failures:

- **Percent-encode the password.** The CLI requires it (`--db-url string
  (must be percent-encoded)`). `@ : / ? # [ ] %` and friends must be escaped —
  a literal `@` in the password will split the URI at the wrong place and
  produce a confusing host-not-found error. Generate the encoded form with:
  ```bash
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' 'the-password'
  ```
- **Port 5432, session mode — not 6543.** The transaction-mode pooler on 6543
  does not support the session-scoped operations a migration needs (advisory
  locks, some prepared statements). Migrations run through it fail in
  non-obvious ways.

The direct host, `db.rbiumegrwtavmljxbknp.supabase.co:5432`, also works and is
marginally simpler. Prefer the pooler anyway: on current Supabase projects the
direct host resolves to IPv6 only unless the IPv4 add-on is enabled, and a
VPS without IPv6 egress gets `dial tcp: network is unreachable`. If you see
that error against the direct host, switch to the session pooler rather than
buying anything.

### 1.3 Single-quote the variable

```bash
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"    # correct
pnpm exec supabase db push --db-url $SUPABASE_DB_URL      # wrong — word-splits
```

---

## 2. Alternative: link the project

Works, but needs an extra secret and writes state into the checkout. Use it
only if §1 is blocked for some reason.

```bash
cd /opt/tugpt
export SUPABASE_ACCESS_TOKEN='sbp_...'          # personal access token
pnpm exec supabase link --project-ref rbiumegrwtavmljxbknp
pnpm exec supabase db push --linked
```

- `SUPABASE_ACCESS_TOKEN` is a **personal access token** from
  <https://supabase.com/dashboard/account/tokens> — a different credential
  from the database password and from the service-role key. It grants
  management-API access to every project the issuing account can see, which is
  a considerably larger blast radius than a single database password. That is
  the main reason §1 is preferred.
- `link` still prompts for the database password unless `-p` is passed, so
  this path does not actually avoid needing it.
- It writes `supabase/.temp/` into the checkout. That directory is
  git-ignored; do not commit it, and expect `git pull` to be unaffected by it.
- Export the token for the command only. Do not add it to any file under
  `/etc/tugpt/`, and do not put it in a shell rc file.

---

## 3. What to run right now

As of 2026-08-19 the staging database is behind this checkout by:

- `20260819000001_align_archive_error_codes_and_capture_provider_detail.sql`
  — extended dead-letter allowlist + `failed_jobs.provider_error_detail`
- `20260819000002_expose_applied_migration_versions.sql`
  — the read-only migration-ledger RPC the preflight gate uses

```bash
cd /opt/tugpt
git fetch origin && git checkout main && git pull --ff-only
pnpm install --frozen-lockfile
set -a; . /etc/tugpt/migrate.env; set +a
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
```

Then restart the workers so they pick up the new code, and verify (§4):

```bash
sudo systemctl restart tugpt-draft-worker tugpt-whatsapp-worker
systemctl is-active tugpt-draft-worker tugpt-whatsapp-worker
```

---

## 4. Verifying — the gate

The milestone-1 harness preflight now proves the database matches the
checkout, and **fails the run** if it does not:

```bash
cd /opt/tugpt
pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts preflight \
  --env-file /etc/tugpt/worker.env --env-file /etc/tugpt/web.env
```

It checks two things, both fatal:

1. **Ledger diff.** Every `.sql` file in `supabase/migrations` must have a row
   in `supabase_migrations.schema_migrations`. This is generic — adding a
   migration file extends the check automatically, with no code change. The
   ledger lives in a schema PostgREST does not expose, so it is read through
   `applied_migration_versions()`, a `SECURITY DEFINER` function granted to
   `service_role` only. It returns version and name; never the migration SQL.
2. **Effect probes.** The specific objects the worker depends on are queried
   directly, because a ledger row proves a migration was *recorded*, not that
   it *took effect* — the two diverge after a partially applied migration or a
   ledger row inserted by hand to unstick a push.

A clean run prints:

```
  [ok]   all 37 migration(s) in this checkout are applied (database has 37, latest 20260819000002)
  [ok]   20260819000001: failed_jobs.provider_error_detail column — column is selectable
  [ok]   20260819000001: archive_draft_failed_job 4-argument overload ... — signature present, returned P3B07 DRAFT_JOB_NOT_FOUND
  [ok]   database schema matches this checkout
```

A stale database aborts with `REFUSING TO RUN`, the list of missing
migrations, what each one's absence breaks, and the command from §1.

The probes are read-only. The `archive_draft_failed_job` probe calls the RPC
with a random job id, which the function rejects with `P3B07` before it writes
anything; the raise aborts the transaction.

To check the ledger by hand:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/applied_migration_versions" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{}' | tail -c 400
```

---

## 5. psql fallback — and the bookkeeping row

Applying a migration with `psql` alone is **not equivalent** to
`supabase db push`. `push` does two things: it runs the SQL, and it records the
version in `supabase_migrations.schema_migrations`. Skip the second and the
next `push` will try to re-apply the same file, and the preflight ledger diff
will keep reporting it missing.

If you must use psql (e.g. the CLI is unavailable), do both, in one
transaction:

```bash
psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 <<SQL
\i supabase/migrations/20260819000002_expose_applied_migration_versions.sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260819000002', 'expose_applied_migration_versions')
ON CONFLICT (version) DO NOTHING;
SQL
```

`--single-transaction` matters: without it a failure halfway leaves the
schema partly changed with no ledger row and no clean way back.

Prefer §1. This is a fallback, not a shortcut.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find project ref. Have you run supabase link?` | `db push` with no `--db-url`, `--linked` or `--local`, in an unlinked checkout | Use `--db-url` (§1) |
| `dial tcp ...: network is unreachable` | Direct host is IPv6-only; the VPS has no IPv6 egress | Use the session pooler host (§1.2) |
| `failed SASL auth` / `password authentication failed` | Wrong password, or unencoded special characters | Re-encode (§1.2); reset the password if unknown |
| `Found local migration files to be inserted before the last migration on remote database` | The remote has a migration newer than one you are pushing — usually a hand-applied change or a diverged branch | Do **not** reach for `--include-all` reflexively. Read the list, work out how the remote got ahead, then decide |
| Push succeeds but preflight still fails a probe | Ledger row present, object absent — a partial apply | Re-run the specific migration's SQL (§5), keeping the existing ledger row |
| `permission denied for schema supabase_migrations` when querying by hand | Correct — `service_role` has no direct access | Use `applied_migration_versions()` (§4) |

---

## 7. Rules

- **Migrations are applied from `main`, never from a feature branch.** The
  server tracks `main`; applying a branch's migration produces a database no
  merged commit describes.
- **Never edit a migration that has been applied.** Write a new one. The CLI
  keys the ledger on the version timestamp and will not notice the change.
- **Nothing that runs unattended holds the migration credential.** No systemd
  unit, no worker, no CI job reads `/etc/tugpt/migrate.env`.
- **Anything destructive** — a `DROP`, a data-losing rewrite, a credential
  rotation — is escalated to the owner before it is run, per the standing
  directive. This document covers additive migrations only.
