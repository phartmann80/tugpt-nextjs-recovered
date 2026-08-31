/**
 * @file readme-matches-the-repo.test.ts
 * @description The README makes checkable claims about this repository. This
 * checks them.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-31 three things were true at once:
 *
 *   * The README said Langdock used "auto model routing". Langdock's
 *     OpenAI-compatible endpoint has no `auto` model and returns HTTP 400 for
 *     it. `docs/production_environment.md` §1 recorded that correction on
 *     2026-08-19 — and the README kept the old claim for twelve more days,
 *     because nothing connected the two documents.
 *   * The ADR table stopped at ADR-014. Three ADRs had been accepted since,
 *     one of them the product-direction record.
 *   * The monorepo tree omitted `packages/ai-orchestration` — the package that
 *     builds every prompt — and listed `turbo.json`, `pnpm-workspace.yaml` and
 *     `eslint.config.mjs` as if they lived under `docs/`.
 *
 * None of those is a bug. All three are the README quietly describing a
 * different repository from the one it ships in, which is worse than a missing
 * README: a reader has no way to tell which sentences are still true.
 *
 * So the parts of the README that restate facts the repo already owns — the ADR
 * list, the package list, the model allowlist — are checked against the repo.
 * Prose stays prose; only claims with a mechanical counterpart are asserted.
 *
 * It lives under `apps/worker/tests/` beside
 * `ci-triggers-every-pull-request.test.ts` for the same reason that one does:
 * repository-level guards need a home, and this is where the first one landed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const README = path.join(REPO_ROOT, 'README.md');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

const readme = readFileSync(README, 'utf8');

interface AdrRow {
  readonly id: string;
  readonly href: string;
  readonly status: string;
}

/**
 * Rows of the README's ADR table: `| [ADR-006](docs/adr/…md) | Title | Status |`
 *
 * Deliberately narrow. A looser pattern would also match the inline ADR links
 * scattered through the prose, and then "every ADR is in the table" would pass
 * for an ADR that is only mentioned in a sentence somewhere.
 */
export function parseAdrTable(markdown: string): AdrRow[] {
  const rows: AdrRow[] = [];
  const re = /^\|\s*\[(ADR-\d{3})\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    rows.push({ id: m[1], href: m[2].trim(), status: m[4].trim() });
  }
  return rows;
}

/** The status word an ADR file declares under its `## Status` heading. */
function declaredStatus(adrFile: string): string {
  const body = readFileSync(path.join(ADR_DIR, adrFile), 'utf8');
  const after = body.split(/^##\s+Status\s*$/m)[1];
  if (after === undefined) return '';
  const firstLine = after
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine ?? '').replace(/\*/g, '');
}

const adrFiles = readdirSync(ADR_DIR)
  .filter((f) => /^ADR-\d{3}-.*\.md$/.test(f))
  .sort();

const tableRows = parseAdrTable(readme);

describe('the ADR table parser', () => {
  it('T1: finds the rows in a known-good table (positive control)', () => {
    // If the regex stops matching the README's real formatting, every
    // assertion below passes on an empty list. This is what stops that.
    const fixture = [
      '| ADR | Title | Status |',
      '|---------|---------|---------|',
      '| [ADR-001](docs/adr/ADR-001-monorepo-and-package-boundaries.md) | Monorepo | Accepted |',
      '| [ADR-012](docs/adr/ADR-012-three-provider-failover-chain.md) | Chain | Superseded by ADR-006 |',
    ].join('\n');

    const parsed = parseAdrTable(fixture);
    expect(parsed.map((r) => r.id)).toEqual(['ADR-001', 'ADR-012']);
    expect(parsed[1].status).toBe('Superseded by ADR-006');
  });

  it('T2: does not mistake an inline prose link for a table row', () => {
    const prose = 'See [ADR-013](docs/adr/ADR-013-vps-docker-deployment-target.md) for why.';
    expect(parseAdrTable(prose)).toEqual([]);
  });

  it('T3: finds every row of the real table', () => {
    expect(tableRows.length).toBe(adrFiles.length);
  });
});

describe('the README ADR table against docs/adr/', () => {
  it('T4: lists every ADR that exists', () => {
    // The failure this catches: an ADR is accepted and the table is not
    // touched, so the README describes the architecture as of some earlier
    // date without saying which. ADR-015, 016 and 017 sat unlisted for six days.
    const listed = new Set(tableRows.map((r) => r.id));
    const missing = adrFiles
      .map((f) => f.slice(0, 7))
      .filter((id) => !listed.has(id));

    expect(missing, 'ADRs on disk but not in the README table').toEqual([]);
  });

  it('T5: lists no ADR that does not exist', () => {
    const gone = tableRows.filter((r) => !existsSync(path.join(REPO_ROOT, r.href)));
    expect(gone.map((r) => r.href), 'README table rows pointing at nothing').toEqual([]);
  });

  it('T6: links each row at the file its own number names', () => {
    // A copy-pasted row keeps the previous row's href and reads perfectly.
    const mismatched = tableRows.filter((r) => !path.basename(r.href).startsWith(r.id));
    expect(mismatched.map((r) => `${r.id} -> ${r.href}`)).toEqual([]);
  });

  it('T7: agrees with each ADR about its own status', () => {
    // ADR-006 is "Provisional" and ADR-012 is "Superseded". Those are load-
    // bearing words: a reader deciding whether the provider architecture is
    // settled reads this table, not seventeen files. The comparison is on the
    // first word so that a dated status ("Accepted 2026-08-25") still matches.
    const disagreements: string[] = [];
    for (const row of tableRows) {
      const file = path.basename(row.href);
      const declared = declaredStatus(file);
      const claimed = row.status.split(/\s+/)[0];
      if (!declared.toLowerCase().startsWith(claimed.toLowerCase())) {
        disagreements.push(`${row.id}: README says "${row.status}", the ADR says "${declared}"`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});

/**
 * The fenced block under `## Monorepo Structure`, and nothing else.
 *
 * Scoped deliberately. Searching the whole README for a package name passes as
 * soon as the name appears anywhere — and `ai-orchestration` appears in the
 * status notes further down, so a whole-file search would have called the tree
 * complete while the package was missing from it. That was a real result from
 * the first version of this test, which is the argument for the scoping and for
 * T9 below.
 */
function monorepoTree(markdown: string): string {
  const section = markdown.split(/^##\s+Monorepo Structure\s*$/m)[1] ?? '';
  const fenced = section.match(/```[^\n]*\n([\s\S]*?)```/);
  return fenced ? fenced[1] : '';
}

describe('the README monorepo tree against packages/', () => {
  const tree = monorepoTree(readme);

  it('T8: found the tree, and it is not the whole README', () => {
    // Positive control. If the section heading is renamed, the extractor
    // returns '' and T9 would then fail loudly rather than pass on nothing —
    // but this says so directly, at the right place.
    expect(tree).toContain('packages/');
    expect(tree.length).toBeLessThan(readme.length / 2);
  });

  it('T9: names every workspace package', () => {
    // `ai-orchestration` — the package that builds every prompt, including the
    // anti-invention guardrail — was missing from this tree.
    const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    const missing = dirs.filter((d) => !tree.includes(`${d}/`));
    expect(missing, 'packages/ directories absent from the README tree').toEqual([]);
  });
});

describe('how the README describes Langdock model selection', () => {
  /**
   * `LANGDOCK_ALLOWED_MODELS` in `packages/ai-providers/src/langdock.ts` is a
   * four-model allowlist. `auto` is not on it, and Langdock's OpenAI-compatible
   * endpoint returns HTTP 400 for it. The README said otherwise for twelve days
   * after that was written down in `docs/production_environment.md`.
   *
   * WHAT THIS GUARD IS, AND IS NOT
   *
   * It is a lint on two exact phrases and one required mention. It is **not** a
   * truth-checker: it cannot read a sentence and decide whether it asserts or
   * denies. That is why the banned strings are literal rather than a regex —
   * a pattern loose enough to catch paraphrases also catches the correction
   * ("the endpoint has no `auto` model"), and a guard that forces its own
   * explanation to be deleted is worse than no guard.
   *
   * The positive requirement is what carries the weight. A README that has gone
   * back to describing automatic selection will not mention the variable the
   * server actually reads, so T12 fails whatever words it chose.
   */
  const BANNED = ['auto routing', 'auto model routing', '`auto` routing'];

  it('T10: the banned phrases match the historical sentences (positive control)', () => {
    // Verbatim from README.md before 2026-08-31.
    const before = [
      '| AI providers | Langdock (sole provider, auto model routing — see ADR-006) |',
      "Langdock is never pinned to a specific model — it always uses Langdock's `auto` routing.",
    ];
    for (const line of before) {
      expect(
        BANNED.some((b) => line.toLowerCase().includes(b)),
        `should have been caught: ${line}`
      ).toBe(true);
    }
  });

  it('T11: none of those phrases is in the README', () => {
    const offenders = readme
      .split('\n')
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => BANNED.some((b) => line.toLowerCase().includes(b)));

    expect(
      offenders.map((o) => `line ${o.n}: ${o.line.trim().slice(0, 90)}`),
      'README lines claiming Langdock auto routing'
    ).toEqual([]);
  });

  it('T12: the README names the variable the worker actually reads', () => {
    // The half that survives a rewording. Selection is `LANGDOCK_MODELS`
    // (rotation) or `LANGDOCK_MODEL` (pinned); a README that has drifted back
    // to "it picks for itself" will not mention either.
    expect(readme).toContain('LANGDOCK_MODELS');
    expect(readme).toContain('LANGDOCK_MODEL');
  });
});
