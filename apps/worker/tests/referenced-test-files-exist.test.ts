/**
 * @file referenced-test-files-exist.test.ts
 * @description Source comments point at test files by name. This checks the
 * files are there.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-01, while transmitting the conversation-thread branch, two
 * comments in it pointed at `thread-response-shape.test.ts`:
 *
 *   * `thread/route.ts` — "`thread-response-shape.test.ts` checks the
 *     serialised body rather than the code."
 *   * `proxy-route-coverage.test.ts` — "its response shape is asserted
 *     separately in thread-response-shape.test.ts."
 *
 * No such file was ever written. The assertions those sentences describe are
 * real and they pass; they live in `thread-route.test.ts`, which is where the
 * file ended up being called. Every gate was green, because nothing a compiler
 * or a test runner looks at was wrong.
 *
 * That is the whole problem with a pointer in a comment. A reader who wants to
 * know whether the response shape is actually asserted — a reviewer, or the
 * next person here — goes to look for the file, does not find it, and now has
 * to decide whether the coverage is missing or the name is. This is the same
 * failure `readme-matches-the-repo.test.ts` was written for, one directory
 * down: a document quietly describing a repository other than the one it
 * ships in.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not require every name ever written down to exist. Two comments in
 * `packages/ai-orchestration/tests/` name suites that were deleted on purpose,
 * and both say so in the same sentence — that is accurate history, and a
 * checker that forced those sentences to be rewritten would be making the
 * repository less honest to make itself pass. Those are listed below with the
 * reason, and the list is itself checked: an entry that stops being referenced
 * has to be deleted rather than left to accumulate.
 *
 * It lives under `apps/worker/tests/` beside `readme-matches-the-repo.test.ts`
 * for the same reason that one does: repository-level guards need a home, and
 * this is where they landed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.turbo', 'coverage', '.git']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * Names that appear in source and deliberately have no file.
 *
 * An entry earns its place by naming a suite that was removed on purpose, in a
 * comment that says it was removed. Anything else is the defect this file
 * exists to catch, and belongs fixed rather than listed.
 */
const REMOVED_ON_PURPOSE: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: 'langdock-adapter.test.ts',
    why:
      'Removed 2026-08-19 when the Langdock `auto` model was found not to exist. ' +
      'langdock-model-allowlist.test.ts names it to record what it replaced.',
  },
  {
    name: 'orchestrator-three-provider.test.ts',
    why:
      'Removed with the retired three-provider chain. orchestrator.test.ts names it ' +
      'to record that its scenarios were folded in rather than dropped.',
  },
];

const TEST_FILE_REFERENCE = /[A-Za-z0-9][A-Za-z0-9._-]*\.test\.tsx?/g;

/**
 * Every source file under a directory, skipping generated and vendored trees.
 *
 * Exported so the skip list can be exercised. Nothing generated currently
 * lands under `src/` or `tests/`, so on today's tree the skip list never fires
 * and deleting it changes no result — which is precisely why it is pinned
 * against a fixture instead of against the repository. A build output landing
 * one directory deeper later would otherwise turn every vendored `.test.ts`
 * name into a reported defect.
 */
export function collectFrom(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectFrom(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }

  return found;
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => found.push(...collectFrom(dir));

  for (const workspace of ['apps', 'packages']) {
    const base = path.join(root, workspace);
    for (const pkg of readdirSync(base)) {
      for (const sub of ['src', 'tests']) {
        const dir = path.join(base, pkg, sub);
        try {
          if (statSync(dir).isDirectory()) walk(dir);
        } catch {
          // Not every package has both; absence is not a failure.
        }
      }
    }
  }

  return found;
}

interface Reference {
  name: string;
  from: string;
}

/**
 * Every test-file name mentioned inside a set of files.
 *
 * Split out from the filesystem walk so the comparison below can be run
 * against a corpus this file controls — see the last test. A checker whose
 * only exercise is the repository passing is a checker that has never been
 * shown to fail.
 */
export function referencesIn(contents: ReadonlyMap<string, string>): Reference[] {
  const refs: Reference[] = [];
  for (const [from, text] of contents) {
    for (const match of text.match(TEST_FILE_REFERENCE) ?? []) {
      refs.push({ name: match, from });
    }
  }
  return refs;
}

/**
 * Recorded removals that nothing points at any more.
 *
 * Separated for the same reason as the check above: with only two entries, the
 * real list will not exercise this either way, so the behaviour is pinned
 * against a corpus instead of against today's repository.
 */
export function unusedExemptions(
  exemptions: ReadonlyArray<{ name: string }>,
  referenced: ReadonlySet<string>
): string[] {
  return exemptions.filter((e) => !referenced.has(e.name)).map((e) => e.name);
}

export function danglingReferences(
  contents: ReadonlyMap<string, string>,
  existing: ReadonlySet<string>,
  exempt: ReadonlySet<string>
): Reference[] {
  return referencesIn(contents).filter(
    (ref) => !existing.has(ref.name) && !exempt.has(ref.name)
  );
}

/**
 * This file is not scanned.
 *
 * It is the one place in the repository where names that deliberately do not
 * exist are written down on purpose: the removal list, the narrative above
 * about `thread-response-shape.test.ts`, and the synthetic corpora in T7 and
 * T8. Adding all of those to `REMOVED_ON_PURPOSE` would empty that list of
 * meaning, and the alternative — writing the guard so it cannot describe what
 * it catches — is worse than the small hole this leaves.
 *
 * The hole is exactly one file, and it is not silent: renaming this file makes
 * the path below stale, at which point the file starts scanning itself and
 * fails loudly rather than quietly stopping.
 */
const SELF = path.join('apps', 'worker', 'tests', 'referenced-test-files-exist.test.ts');

const sourceFiles = collectSourceFiles(REPO_ROOT);
const contents = new Map(
  sourceFiles
    .map((f) => [path.relative(REPO_ROOT, f), readFileSync(f, 'utf8')] as const)
    .filter(([rel]) => rel !== SELF)
);
const existingTestFiles = new Set(
  sourceFiles.map((f) => path.basename(f)).filter((b) => /\.test\.tsx?$/.test(b))
);
const exemptNames = new Set(REMOVED_ON_PURPOSE.map((e) => e.name));

describe('test files named in source comments', () => {
  it('T1: every referenced test file exists, or is a recorded removal', () => {
    const dangling = danglingReferences(contents, existingTestFiles, exemptNames);

    expect(
      dangling.map((d) => `${d.from} points at ${d.name}, which does not exist`)
    ).toEqual([]);
  });

  it('T2: the walk actually reached the source tree', () => {
    // Without this, deleting the body of `walk` turns T1 into a test that
    // asserts the empty list equals the empty list, and passes forever.
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(contents.has(path.join('apps', 'worker', 'tests', 'readme-matches-the-repo.test.ts'))).toBe(
      true
    );
    expect(contents.has(path.join('apps', 'web', 'src', 'proxy-route-coverage.test.ts'))).toBe(true);
  });

  it('T3: the extractor finds a reference that is known to be there', () => {
    // Positive control on the regex. `thread/route.ts` names the suite that
    // asserts its response shape; if this stops being found, T1 has gone quiet
    // rather than green.
    const names = new Set(referencesIn(contents).map((r) => r.name));
    expect(names.has('thread-route.test.ts')).toBe(true);
    expect(names.has('langdock-adapter.test.ts')).toBe(true);
  });

  it('T3b: this file is excluded from the scan, and only this file', () => {
    // The exclusion is a hole in the guard, so its size is asserted rather
    // than trusted. If the file is renamed, SELF stops matching, this fails,
    // and T1 starts reporting this file's illustrative names — loud both ways.
    expect(sourceFiles.some((f) => path.relative(REPO_ROOT, f) === SELF)).toBe(true);
    expect(contents.has(SELF)).toBe(false);
    expect(contents.size).toBe(sourceFiles.length - 1);
  });

  it('T4: the index of real test files is populated', () => {
    expect(existingTestFiles.size).toBeGreaterThan(20);
    expect(existingTestFiles.has('thread-route.test.ts')).toBe(true);
  });

  it('T5: every recorded removal is still referenced somewhere', () => {
    // An exemption whose reference has since been deleted is dead weight that
    // silences a future defect under the same name.
    const referenced = new Set(referencesIn(contents).map((r) => r.name));

    expect(unusedExemptions(REMOVED_ON_PURPOSE, referenced)).toEqual([]);
  });

  it('T4b: the walk skips generated and vendored trees', () => {
    // On today's tree nothing generated sits under src/ or tests/, so this is
    // the only thing that holds the skip list up.
    const root = mkdtempSync(path.join(tmpdir(), 'tugpt-walk-'));
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'kept.ts'), '');
    writeFileSync(path.join(root, 'nested', 'also-kept.tsx'), '');
    writeFileSync(path.join(root, 'ignored.md'), '');
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'vendored.test.ts'), '');
    writeFileSync(path.join(root, 'dist', 'built.test.ts'), '');

    const found = collectFrom(root).map((f) => path.relative(root, f)).sort();

    expect(found).toEqual(['kept.ts', path.join('nested', 'also-kept.tsx')]);
  });

  it('T5b: the rot check reports an exemption nothing points at', () => {
    expect(
      unusedExemptions(
        [{ name: 'still-referenced.test.ts' }, { name: 'orphaned.test.ts' }],
        new Set(['still-referenced.test.ts'])
      )
    ).toEqual(['orphaned.test.ts']);
  });

  it('T6: every recorded removal explains itself', () => {
    for (const entry of REMOVED_ON_PURPOSE) {
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  it('T7: the check reports a dangling reference when there is one', () => {
    // The one that matters. T1 passing proves the repository is clean only if
    // the comparison behind it can fail — run it over a corpus with a known
    // bad pointer and a known good one.
    const corpus = new Map([
      ['a.ts', 'see thread-route.test.ts for the shape assertions'],
      ['b.ts', 'covered by nonexistent-suite.test.ts'],
    ]);

    const dangling = danglingReferences(corpus, existingTestFiles, exemptNames);

    expect(dangling).toEqual([{ name: 'nonexistent-suite.test.ts', from: 'b.ts' }]);
  });

  it('T8: an exemption suppresses exactly the name it names', () => {
    const corpus = new Map([['a.ts', 'langdock-adapter.test.ts and other-gone.test.ts']]);

    const dangling = danglingReferences(corpus, existingTestFiles, exemptNames);

    expect(dangling.map((d) => d.name)).toEqual(['other-gone.test.ts']);
  });
});
