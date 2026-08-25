/**
 * docs/server-migrations.md is the procedure for applying migrations from the
 * server. Section 4 shows what a clean preflight prints, including a real
 * migration count and the real latest version — precise numbers, which is what
 * makes the sample useful for spotting a stale database at a glance.
 *
 * Precise numbers also rot. That block said `all 37 migration(s) ... latest
 * 20260819000002` from the day the document was written until 2026-08-25 — wrong
 * from one commit later, when 20260819000003 landed and nothing connected the
 * two. An operator comparing their real output against it would have seen a
 * mismatch and had to work out which of the two was lying.
 *
 * These tests read the numbers back out of the delimited block and compare them
 * against the checkout, using `readRepoMigrationVersions` — the same function
 * the preflight itself uses, so the doc is pinned to the code's own view of the
 * migrations directory rather than to a second implementation of it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readRepoMigrationVersions } from '../src/e2e/schema-expectations.js';

const DOC_PATH = path.join(process.cwd(), '..', '..', 'docs', 'server-migrations.md');

const START = '<!-- schema-gate-sample:start -->';
const END = '<!-- schema-gate-sample:end -->';

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function sampleBlock(doc: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/server-migrations.md must contain ${START} ... ${END} around the section 4 ` +
        `sample output. Removing the markers does not make this test pass; it makes the ` +
        `numbers in that block unverifiable.`
    );
  }
  return doc.slice(start + START.length, end);
}

/** The migrations this checkout contains, as the preflight counts them. */
function repoVersions(): string[] {
  const versions = readRepoMigrationVersions();
  if (versions === null || versions.length === 0) {
    throw new Error('could not read supabase/migrations from the checkout');
  }
  return versions;
}

describe('server-migrations.md schema-gate sample', () => {
  it('finds the document (a moved file must fail loudly, not silently pass)', () => {
    expect(existsSync(DOC_PATH), `expected the migrations runbook at ${DOC_PATH}`).toBe(true);
  });

  it('is delimited by the markers the test reads', () => {
    expect(() => sampleBlock(readDoc())).not.toThrow();
  });

  it('quotes the migration count this checkout actually has', () => {
    const block = sampleBlock(readDoc());
    const expected = repoVersions().length;

    // Both numbers on that line are the same count: the repo's, and the
    // database's after a successful push.
    expect(block, `sample should say "all ${expected} migration(s)"`).toContain(
      `all ${expected} migration(s) in this checkout are applied`
    );
    expect(block, `sample should say "database has ${expected}"`).toContain(
      `(database has ${expected}, latest `
    );
  });

  it('quotes the latest migration version in this checkout', () => {
    const block = sampleBlock(readDoc());
    const versions = repoVersions();
    const latest = versions[versions.length - 1];

    expect(block, `sample should say "latest ${latest}"`).toContain(`latest ${latest})`);
  });

  it('does not quote a stale version as the latest', () => {
    const block = sampleBlock(readDoc());
    const versions = repoVersions();
    const latest = versions[versions.length - 1];

    // Any 14-digit version named as "latest" must be the real one. This catches
    // the specific way the block went wrong: a correct-looking number that was
    // simply from an earlier day.
    const claimed = [...block.matchAll(/latest (\d{14})/g)].map((m) => m[1]);
    expect(claimed.length).toBeGreaterThan(0);
    for (const version of claimed) {
      expect(version, `"latest ${version}" is not the newest migration`).toBe(latest);
    }
  });

  /**
   * The manual ledger check in section 4 used `$SUPABASE_URL`, which is defined
   * in no env file and no source file in this project — sourcing worker.env
   * leaves it empty and the curl goes to a hostless URL. The variable is
   * NEXT_PUBLIC_SUPABASE_URL everywhere else.
   */
  it('never names the unprefixed SUPABASE_URL, which nothing defines', () => {
    const doc = readDoc();
    const offenders = [...doc.matchAll(/\$\{?SUPABASE_URL\b/g)].map((m) => m[0]);
    expect(offenders, 'use $NEXT_PUBLIC_SUPABASE_URL').toEqual([]);
  });
});
