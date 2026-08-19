/**
 * @file schema-expectations.test.ts
 * @description Tests for the migration-presence gate added to the milestone-1
 * harness preflight on 2026-08-19.
 *
 * The gate exists because the first milestone-1 run reported success against a
 * database missing migration 20260819000001. These tests pin the two ways it
 * can fail open: mis-parsing the checkout's migration list, and
 * mis-classifying a probe error as "present".
 *
 * milestone1.ts is deliberately not imported (loading it executes main()), so
 * the gate's logic lives in schema-expectations.ts where it can be tested.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMigrationVersion,
  versionsFromListing,
  missingVersions,
  findMigrationsDir,
  readRepoMigrationVersions,
  fetchAppliedMigrationVersions,
  SCHEMA_EXPECTATIONS,
  MIGRATION_REMEDIATION,
  PGRST_FUNCTION_NOT_FOUND,
  PG_UNDEFINED_COLUMN,
} from '../src/e2e/schema-expectations';

describe('parseMigrationVersion', () => {
  it('takes the leading timestamp, as the Supabase CLI does', () => {
    expect(
      parseMigrationVersion('20260819000001_align_archive_error_codes_and_capture_provider_detail.sql')
    ).toBe('20260819000001');
  });

  it('ignores files that are not migrations', () => {
    expect(parseMigrationVersion('README.md')).toBeNull();
    expect(parseMigrationVersion('.keep')).toBeNull();
    expect(parseMigrationVersion('20260819000001_no_extension')).toBeNull();
    expect(parseMigrationVersion('draft_rpcs.sql')).toBeNull();
    // Wrong timestamp width would silently produce a version the ledger can
    // never match, so it must not parse.
    expect(parseMigrationVersion('202608190_short.sql')).toBeNull();
  });
});

describe('versionsFromListing', () => {
  it('sorts ascending regardless of directory order', () => {
    expect(
      versionsFromListing([
        '20260819000002_b.sql',
        'README.md',
        '20260716000001_initial_schema.sql',
        '20260819000001_a.sql',
      ])
    ).toEqual(['20260716000001', '20260819000001', '20260819000002']);
  });

  it('returns an empty list for a directory with no migrations', () => {
    expect(versionsFromListing(['README.md'])).toEqual([]);
  });
});

describe('missingVersions', () => {
  it('reports migrations the checkout has and the database does not', () => {
    expect(missingVersions(['1', '2', '3'], ['1', '2'])).toEqual(['3']);
  });

  it('reports nothing when the database is up to date', () => {
    expect(missingVersions(['1', '2'], ['1', '2'])).toEqual([]);
  });

  it('does not complain when the database is AHEAD of the checkout', () => {
    // That is what an older checkout looks like. It is the operator's
    // business; the harness only cares that its own expectations are met.
    expect(missingVersions(['1', '2'], ['1', '2', '3'])).toEqual([]);
  });

  it('detects a gap in the middle, not just a missing tail', () => {
    expect(missingVersions(['1', '2', '3'], ['1', '3'])).toEqual(['2']);
  });
});

describe('locating the checkout migrations', () => {
  it('finds the real supabase/migrations directory from this test file', () => {
    const dir = findMigrationsDir(__dirname);
    expect(dir).not.toBeNull();
    expect(dir as string).toMatch(/supabase[/\\]migrations$/);
  });

  it('returns null when there is no repo above the start directory', () => {
    expect(findMigrationsDir('/', 2)).toBeNull();
  });

  it('reads this repo and includes the migrations the gate exists for', () => {
    const versions = readRepoMigrationVersions(findMigrationsDir(__dirname));
    expect(versions).not.toBeNull();
    expect(versions as string[]).toContain('20260819000001');
    expect(versions as string[]).toContain('20260819000002');
  });

  it('returns null rather than throwing for an unreadable directory', () => {
    expect(readRepoMigrationVersions('/nonexistent/path/for/test')).toBeNull();
    expect(readRepoMigrationVersions(null)).toBeNull();
  });
});

// --- ledger -----------------------------------------------------------------

function adminReturning(result: unknown): { rpc: () => Promise<unknown> } {
  return { rpc: async () => result };
}

describe('fetchAppliedMigrationVersions', () => {
  it('returns sorted versions from the ledger', async () => {
    const admin = adminReturning({
      data: [{ version: '20260819000002' }, { version: '20260716000001' }],
      error: null,
    });
    const result = await fetchAppliedMigrationVersions(admin);
    expect(result.available).toBe(true);
    expect(result.versions).toEqual(['20260716000001', '20260819000002']);
  });

  it('treats a missing RPC as unavailable and says why', async () => {
    const admin = adminReturning({
      data: null,
      error: { code: PGRST_FUNCTION_NOT_FOUND, message: 'not found in schema cache' },
    });
    const result = await fetchAppliedMigrationVersions(admin);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('20260819000002');
  });

  it('treats an empty ledger as unavailable, not as "nothing missing"', async () => {
    // Failing closed matters here: an empty list would otherwise diff clean
    // against a checkout only if the checkout were also empty, but a caller
    // that ignored `available` would read it as success.
    const admin = adminReturning({ data: [], error: null });
    const result = await fetchAppliedMigrationVersions(admin);
    expect(result.available).toBe(false);
    expect(result.versions).toEqual([]);
  });

  it('treats any other error as unavailable', async () => {
    const admin = adminReturning({ data: null, error: { code: '42501', message: 'permission denied' } });
    const result = await fetchAppliedMigrationVersions(admin);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('permission denied');
  });
});

// --- effect probes ----------------------------------------------------------

const columnExpectation = SCHEMA_EXPECTATIONS.find((e) =>
  e.describes.includes('provider_error_detail')
);
const rpcExpectation = SCHEMA_EXPECTATIONS.find((e) => e.describes.includes('4-argument'));

/** Minimal stand-in for the parts of the Supabase client the probes touch. */
function fakeAdmin(opts: { selectResult?: unknown; rpcResult?: unknown }): unknown {
  return {
    from: () => ({
      select: () => ({ limit: async () => opts.selectResult }),
    }),
    rpc: async () => opts.rpcResult,
  };
}

describe('every expectation names a migration that exists in the checkout', () => {
  it('has no stale entries', () => {
    const versions = readRepoMigrationVersions(findMigrationsDir(__dirname)) ?? [];
    for (const expectation of SCHEMA_EXPECTATIONS) {
      expect(versions).toContain(expectation.migration);
    }
  });
});

describe('failed_jobs.provider_error_detail probe', () => {
  it('passes when the column selects cleanly', async () => {
    const result = await columnExpectation!.probe(fakeAdmin({ selectResult: { error: null } }));
    expect(result.present).toBe(true);
  });

  it('fails on undefined_column — the exact 2026-08-19 symptom', async () => {
    const result = await columnExpectation!.probe(
      fakeAdmin({
        selectResult: {
          error: {
            code: PG_UNDEFINED_COLUMN,
            message: 'column failed_jobs.provider_error_detail does not exist',
          },
        },
      })
    );
    expect(result.present).toBe(false);
    expect(result.detail).toContain('does not exist');
  });

  it('fails on an inconclusive error rather than assuming presence', async () => {
    const result = await columnExpectation!.probe(
      fakeAdmin({ selectResult: { error: { code: '08006', message: 'connection failure' } } })
    );
    expect(result.present).toBe(false);
  });
});

describe('archive_draft_failed_job 4-argument probe', () => {
  it('passes when the RPC rejects the random job id with P3B07', async () => {
    const result = await rpcExpectation!.probe(
      fakeAdmin({ rpcResult: { error: { code: 'P3B07', message: 'DRAFT_JOB_NOT_FOUND' } } })
    );
    expect(result.present).toBe(true);
  });

  it('fails when only the old 3-argument overload exists', async () => {
    const result = await rpcExpectation!.probe(
      fakeAdmin({
        rpcResult: {
          error: {
            code: PGRST_FUNCTION_NOT_FOUND,
            message: 'Could not find the function public.archive_draft_failed_job(...)',
          },
        },
      })
    );
    expect(result.present).toBe(false);
    expect(result.detail).toContain('3-argument');
  });

  it('fails if the probe somehow succeeds, which would mean it archived something', async () => {
    const result = await rpcExpectation!.probe(fakeAdmin({ rpcResult: { data: [], error: null } }));
    expect(result.present).toBe(false);
  });

  it('fails on any other SQLSTATE, including P3B15 from a stale allowlist', async () => {
    const result = await rpcExpectation!.probe(
      fakeAdmin({ rpcResult: { error: { code: 'P3B15', message: 'INVALID_DRAFT_FAILURE_CODE' } } })
    );
    expect(result.present).toBe(false);
  });
});

describe('remediation text', () => {
  it('tells the operator the command and where the full procedure lives', () => {
    expect(MIGRATION_REMEDIATION).toContain('supabase db push');
    expect(MIGRATION_REMEDIATION).toContain('docs/server-migrations.md');
  });
});
