/**
 * @file schema-expectations.ts
 * @description Asserts that the database the harness is pointed at is running
 * the schema this checkout expects.
 *
 * WHY THIS EXISTS
 * The 2026-08-19 milestone-1 run reported success while migration
 * 20260819000001 had never been applied to staging. The repo checkout on the
 * VPS had never been linked to a Supabase project, `supabase db push` failed
 * with "Cannot find project ref", and nothing downstream treated that as
 * fatal. The harness did notice — it printed `[WARN] could not read
 * failed_jobs: column provider_error_detail does not exist` — and then carried
 * on. A warning nobody is forced to act on is not a check. Everything here is
 * designed to stop the run instead.
 *
 * TWO LAYERS
 *
 * 1. LEDGER DIFF (generic, self-maintaining). Every .sql file in
 *    supabase/migrations is compared against the versions recorded in
 *    supabase_migrations.schema_migrations. Any migration present in the
 *    checkout but not in the database fails preflight. This needs no
 *    maintenance: adding a migration file automatically adds it to the
 *    expected set.
 *
 *    The ledger lives in the `supabase_migrations` schema, which is not in
 *    PostgREST's exposed-schema list, so it is read through the
 *    `applied_migration_versions` SECURITY DEFINER RPC (service-role only,
 *    added in 20260819000002).
 *
 * 2. EFFECT PROBES (specific, stronger). The ledger records intent, not
 *    outcome: a row can be present while the objects it claims to have created
 *    are not — after a partially applied migration, a hand-edited database, or
 *    a ledger row inserted manually to "unstick" a push. So the schema changes
 *    the worker actually depends on are additionally probed through the same
 *    PostgREST interface the worker uses. A probe that passes proves the object
 *    is really there.
 *
 * ADDING A MIGRATION
 * Layer 1 picks it up for free. Add a layer-2 entry only when the migration
 * changes something whose absence would corrupt a run rather than fail it
 * loudly. Keep probes read-only: preflight runs against a live database.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Untyped Supabase client — the generated types do not cover these RPCs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Shape supabase-js gives back on failure. */
interface PostgrestErrorish {
  code?: string;
  message?: string;
}

/** PostgREST: no function matches the name + argument list in the schema cache. */
export const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';
/** PostgreSQL: undefined_column. */
export const PG_UNDEFINED_COLUMN = '42703';

// --- layer 1: ledger diff -------------------------------------------------

/**
 * Extract the version from a migration filename.
 *
 * The Supabase CLI records the leading timestamp as the version and the rest
 * as the name: `20260819000001_align_archive_error_codes.sql` -> `20260819000001`.
 *
 * @returns the version, or null when the filename is not a migration.
 */
export function parseMigrationVersion(filename: string): string | null {
  const match = /^(\d{14})_.*\.sql$/.exec(filename);
  return match ? match[1] : null;
}

/** Migration versions present in the checkout, ascending. Pure given a listing. */
export function versionsFromListing(filenames: readonly string[]): string[] {
  return filenames
    .map(parseMigrationVersion)
    .filter((v): v is string => v !== null)
    .sort();
}

/**
 * Versions the checkout has that the database does not.
 *
 * Migrations applied to the database but absent from the checkout are NOT an
 * error: that is what a checkout of an older commit looks like, and it is the
 * operator's business, not the harness's. The harness only cares that
 * everything this code expects is present.
 */
export function missingVersions(
  repoVersions: readonly string[],
  appliedVersions: readonly string[]
): string[] {
  const applied = new Set(appliedVersions);
  return repoVersions.filter((v) => !applied.has(v));
}

/**
 * Absolute path to supabase/migrations.
 *
 * Found by walking up from this module's own directory rather than from the
 * working directory, so it does not matter where the harness is invoked from.
 * It walks rather than counting levels because the depth differs between the
 * source tree (apps/worker/src/e2e) and the build output (apps/worker/dist/e2e),
 * and the harness is run both ways.
 *
 * @returns the directory, or null when no repo root is found above this file.
 */
export function findMigrationsDir(startDir: string = __dirname, maxLevels = 10): string | null {
  let current = resolve(startDir);
  for (let level = 0; level <= maxLevels; level++) {
    const candidate = join(current, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Migration versions in the checkout. Returns null when the directory is unreadable. */
export function readRepoMigrationVersions(dir: string | null = findMigrationsDir()): string[] | null {
  if (dir === null) return null;
  try {
    return versionsFromListing(readdirSync(dir));
  } catch {
    return null;
  }
}

export interface LedgerResult {
  /** Versions recorded in supabase_migrations.schema_migrations, ascending. */
  versions: string[];
  /** False when the RPC that exposes the ledger is not installed. */
  available: boolean;
  /** Set when the ledger could not be read. */
  reason?: string;
}

export async function fetchAppliedMigrationVersions(admin: Db): Promise<LedgerResult> {
  const { data, error } = await admin.rpc('applied_migration_versions');

  if (error) {
    const err = error as PostgrestErrorish;
    if (err.code === PGRST_FUNCTION_NOT_FOUND) {
      return {
        versions: [],
        available: false,
        reason:
          'applied_migration_versions() is not installed, which itself means migration ' +
          '20260819000002 (or later) has not been applied',
      };
    }
    return {
      versions: [],
      available: false,
      reason: `could not read the migration ledger (${err.code ?? 'no code'}): ${err.message}`,
    };
  }

  const rows = (data ?? []) as Array<{ version?: string } | string>;
  const versions = rows
    .map((row) => (typeof row === 'string' ? row : row.version))
    .filter((v): v is string => typeof v === 'string')
    .sort();

  if (versions.length === 0) {
    return {
      versions: [],
      available: false,
      reason:
        'the migration ledger is empty — supabase_migrations.schema_migrations is missing or ' +
        'has never been written, so this database was not built by `supabase db push`',
    };
  }

  return { versions, available: true };
}

// --- layer 2: effect probes -----------------------------------------------

export interface ProbeResult {
  /** True when the schema change is present. */
  present: boolean;
  /** Human-readable explanation, shown on both pass and fail. */
  detail: string;
}

export interface SchemaExpectation {
  /** Migration filename prefix, e.g. '20260819000001'. */
  migration: string;
  /** One-line description of the schema change. */
  describes: string;
  /** What breaks at runtime if this migration is missing. */
  consequence: string;
  probe: (admin: Db) => Promise<ProbeResult>;
}

/**
 * A msg_id that cannot collide with a real PGMQ message: PGMQ ids are positive
 * bigints, so a negative one can never match an existing failed_jobs row.
 */
const PROBE_MSG_ID = -1;

export const SCHEMA_EXPECTATIONS: readonly SchemaExpectation[] = [
  {
    migration: '20260819000001',
    describes: 'failed_jobs.provider_error_detail column',
    consequence:
      "the provider's own error text is dropped from every dead-letter record, so a terminal " +
      'failure can only be diagnosed by calling the provider API by hand',
    async probe(admin: Db): Promise<ProbeResult> {
      const { error } = await admin.from('failed_jobs').select('provider_error_detail').limit(1);
      if (!error) return { present: true, detail: 'column is selectable' };

      const err = error as PostgrestErrorish;
      if (err.code === PG_UNDEFINED_COLUMN) {
        return { present: false, detail: 'column does not exist' };
      }
      // An inconclusive probe is a failure. Preflight must not pass on "we
      // could not tell".
      return { present: false, detail: `probe failed (${err.code ?? 'no code'}): ${err.message}` };
    },
  },
  {
    migration: '20260819000001',
    describes: 'archive_draft_failed_job 4-argument overload (extended error-code allowlist)',
    consequence:
      'every terminal provider failure is rejected with P3B15, its queue message is neither ' +
      'archived nor deleted, and it is redelivered until it dead-letters as ' +
      'DRAFT_EXHAUSTED_RETRIES — the exact defect this migration fixes',
    async probe(admin: Db): Promise<ProbeResult> {
      // Read-only by construction: the RPC looks the job up and raises P3B07
      // before it writes anything, and the raise aborts the transaction. A
      // random UUID cannot match a real job.
      const { error } = await admin.rpc('archive_draft_failed_job', {
        p_msg_id: PROBE_MSG_ID,
        p_draft_generation_job_id: randomUUID(),
        p_error_code: 'DRAFT_INTERNAL_ERROR',
        p_provider_error_detail: 'preflight probe',
      });

      if (!error) {
        return { present: false, detail: 'probe unexpectedly succeeded against a random job id' };
      }

      const err = error as PostgrestErrorish;
      if (err.code === 'P3B07') {
        // The 4-arg signature exists and rejected the probe for the right
        // reason. The extended allowlist ships in the same DROP/CREATE, so
        // there is no state in which one is applied without the other.
        return { present: true, detail: 'signature present, returned P3B07 DRAFT_JOB_NOT_FOUND' };
      }
      if (err.code === PGRST_FUNCTION_NOT_FOUND) {
        return {
          present: false,
          detail: 'no 4-argument overload — only the old 3-argument version exists',
        };
      }
      return { present: false, detail: `probe failed (${err.code ?? 'no code'}): ${err.message}` };
    },
  },
] as const;

/**
 * What an operator should do when any of the above fails.
 * Full procedure: docs/server-migrations.md
 */
export const MIGRATION_REMEDIATION = [
  'Apply the outstanding migrations on the server, then re-run preflight:',
  '',
  '  cd /opt/tugpt',
  '  set -a; . /etc/tugpt/migrate.env; set +a',
  '  pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"',
  '',
  'The connection string and where its credential lives are documented in',
  'docs/server-migrations.md. Do not hand-apply SQL with psql without also',
  'writing the supabase_migrations.schema_migrations row — see §5 of that doc.',
].join('\n');
