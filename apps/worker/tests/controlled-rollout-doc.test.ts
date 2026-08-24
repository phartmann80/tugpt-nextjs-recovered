/**
 * docs/controlled-rollout.md is the procedure for turning on AI draft
 * generation. Its §5 table tells an operator, mid-rollout, what each terminal
 * outcome means and what to do about it. An operator reading that table trusts
 * it to be complete: a code that is not in it reads as "something unexpected",
 * and a code that is in it but cannot occur sends them looking for a row the
 * database will never contain.
 *
 * Both failure modes were live in that document until 2026-08-24. It listed
 * `NO_ACTIVE_QUOTA_PERIOD` as the skip reason for an unbudgeted organization —
 * that string is a `reason` returned by `private.reserve_draft_usage`, which the
 * worker logs and discards; every quota denial reaches the database as
 * `QUOTA_DENIED`. And it omitted `DRAFT_INVALID_CONFIG` entirely, describing a
 * missing `ai_draft_configs` row as producing "generic" drafts when it
 * dead-letters the job — the single most likely way a first pilot produces no
 * drafts at all.
 *
 * Nothing about editing the worker would have revealed either. The document and
 * the code were two independent statements of the same fact, and only one of
 * them ran.
 *
 * These tests bind them together. The table is delimited by
 * `<!-- outcome-table:start -->` / `<!-- outcome-table:end -->` and must match
 * the worker's own lists exactly, in both directions.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  APPROVED_ARCHIVE_ERROR_CODES,
  DRAFT_SKIP_REASONS,
} from '../src/draft-rpc-error-codes.js';

const DOC_PATH = path.join(process.cwd(), '..', '..', 'docs', 'controlled-rollout.md');

const START = '<!-- outcome-table:start -->';
const END = '<!-- outcome-table:end -->';

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

/** The delimited table, or a thrown error naming what is missing. */
function outcomeTable(doc: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/controlled-rollout.md must contain ${START} ... ${END} around the §5 outcome table. ` +
        `Removing the markers does not make this test pass; it makes the table unverifiable.`
    );
  }
  return doc.slice(start + START.length, end);
}

/**
 * Codes named in the table. Deliberately matches the whole shouty-token
 * vocabulary rather than only the codes we expect, so a row naming an invented
 * or retired code is caught rather than ignored.
 */
function codesIn(section: string): Set<string> {
  const found = section.match(/\b(?:DRAFT_[A-Z_]+|FEATURE_DISABLED|QUOTA_DENIED)\b/g) ?? [];
  return new Set(found);
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('controlled-rollout.md outcome table', () => {
  it('finds the document (a moved file must fail loudly, not silently pass)', () => {
    expect(existsSync(DOC_PATH), `expected the rollout doc at ${DOC_PATH}`).toBe(true);
  });

  it('is delimited by the markers the test reads', () => {
    expect(() => outcomeTable(readDoc())).not.toThrow();
  });

  it('lists every terminal outcome the worker can produce, and nothing it cannot', () => {
    const documented = codesIn(outcomeTable(readDoc()));
    const produced = new Set<string>([...APPROVED_ARCHIVE_ERROR_CODES, ...DRAFT_SKIP_REASONS]);

    // A failure here is one of two things, and the diff says which:
    //   extra in `produced`   -> a code was added to the worker; document it
    //   extra in `documented` -> the table names something unreachable
    expect(sorted(documented)).toEqual(sorted(produced));
  });

  it('documents both skip reasons, which are the outcomes that are not failures', () => {
    const documented = codesIn(outcomeTable(readDoc()));
    for (const reason of DRAFT_SKIP_REASONS) {
      expect(documented.has(reason), `${reason} is missing from the outcome table`).toBe(true);
    }
  });

  it('does not resurrect NO_ACTIVE_QUOTA_PERIOD as a persisted value', () => {
    const doc = readDoc();
    const table = outcomeTable(doc);

    // It may still be discussed in prose — §2 explains why it is NOT what you
    // will see — but it must never appear as an outcome to look for.
    expect(table).not.toContain('NO_ACTIVE_QUOTA_PERIOD');

    // And the explanation itself has to survive, or the correction is lost the
    // next time somebody tidies the checklist.
    expect(doc).toContain('QUOTA_DENIED');
    expect(doc).toContain('NO_ACTIVE_QUOTA_PERIOD');
  });
});
