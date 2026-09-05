/**
 * docs/database-tests.md is the map of the pgTAP suite: a file count in the
 * header and a table saying what each file guards. Both numbers and both lists
 * were hand-maintained, and a hand-maintained inventory of a directory is a
 * stale document waiting to happen — the same failure `server-migrations-doc`
 * exists to prevent, one directory over.
 *
 * The header said "24 files" while the directory held 24, then 25, and nothing
 * would have said so. The table is worse than the count: a new test file that
 * never reaches the table is a guard nobody can find, which is close to a guard
 * that does not exist. The document's whole job is answering "what covers this
 * behaviour, and where do I add the next one" — it answers wrongly the moment
 * it drifts.
 *
 * So the count is read back out of a delimited block, and every `.sql` file in
 * the directory must be named somewhere in the coverage table. The reverse is
 * checked too: a file named in the table that no longer exists sends a reader
 * looking for something that was deleted.
 *
 * What this does NOT check is whether the description is *true* — no test can.
 * It checks that a file cannot be added or removed without someone writing or
 * deleting a line here on purpose.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(process.cwd(), '..', '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'database-tests.md');
const TESTS_DIR = path.join(REPO_ROOT, 'supabase', 'tests', 'database');

const COUNT_START = '<!-- database-tests-count:start -->';
const COUNT_END = '<!-- database-tests-count:end -->';

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

/** The `.sql` files pgTAP will actually run, as `supabase test db` finds them. */
export function suiteFiles(dir: string = TESTS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function countBlock(doc: string): string {
  const start = doc.indexOf(COUNT_START);
  const end = doc.indexOf(COUNT_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/database-tests.md must contain ${COUNT_START} ... ${COUNT_END} around the ` +
        `file count in the header. Removing the markers does not make this test pass; ` +
        `it makes the number unverifiable.`
    );
  }
  return doc.slice(start + COUNT_START.length, end);
}

/**
 * The coverage table, as raw text. Cells name files in backticks, several to a
 * row, so this deliberately does not try to parse rows — membership is the only
 * question being asked.
 */
export function coverageTable(doc: string): string {
  const heading = doc.indexOf('## What the suite covers');
  if (heading === -1) {
    throw new Error('docs/database-tests.md must contain a "## What the suite covers" section');
  }
  const next = doc.indexOf('\n## ', heading + 1);
  return doc.slice(heading, next === -1 ? doc.length : next);
}

/** Every `foo.test.sql` named inside backticks in the table. */
export function filesNamedIn(table: string): string[] {
  return [...new Set([...table.matchAll(/`([A-Za-z0-9_]+\.test\.sql)`/g)].map((m) => m[1]))].sort();
}

describe('database-tests.md matches the pgTAP directory', () => {
  it('finds both the document and the suite (a moved file must fail loudly, not silently pass)', () => {
    // Both doc guards in this directory resolve paths from process.cwd(), so
    // they pass vacuously when vitest is run from the repo root instead of the
    // package. That is a real failure mode this project has already hit once,
    // which is why the existence of the inputs is asserted rather than assumed.
    expect(existsSync(DOC_PATH), `expected the suite map at ${DOC_PATH}`).toBe(true);
    expect(existsSync(TESTS_DIR), `expected the pgTAP suite at ${TESTS_DIR}`).toBe(true);
    expect(suiteFiles().length).toBeGreaterThan(0);
  });

  it('is delimited by the markers the test reads', () => {
    expect(() => countBlock(readDoc())).not.toThrow();
    expect(() => coverageTable(readDoc())).not.toThrow();
  });

  it('quotes the number of test files this checkout actually has', () => {
    const block = countBlock(readDoc());
    const expected = suiteFiles().length;

    expect(block, `header should say "${expected} files"`).toContain(`${expected} files`);
  });

  it('does not quote a stale count', () => {
    // The count could be right by accident if some other number in the block
    // matched. Any "<n> files" in there must be the real one.
    const block = countBlock(readDoc());
    const expected = suiteFiles().length;
    const claimed = [...block.matchAll(/(\d+) files/g)].map((m) => Number(m[1]));

    expect(claimed.length).toBeGreaterThan(0);
    for (const n of claimed) {
      expect(n, `"${n} files" is not the number of .sql files in the suite`).toBe(expected);
    }
  });

  it('names every test file in the coverage table', () => {
    const documented = new Set(filesNamedIn(coverageTable(readDoc())));
    const undocumented = suiteFiles().filter((f) => !documented.has(f));

    // A new pgTAP file lands here. Add a row saying what it guards — the point
    // of the table is that a reader can find the test that covers a behaviour,
    // and a file missing from it is close to a test that does not exist.
    expect(undocumented, 'add a row to "What the suite covers"').toEqual([]);
  });

  it('names no test file that has been deleted', () => {
    const present = new Set(suiteFiles());
    const dangling = filesNamedIn(coverageTable(readDoc())).filter((f) => !present.has(f));

    expect(dangling, 'the table sends readers to files that no longer exist').toEqual([]);
  });
});
