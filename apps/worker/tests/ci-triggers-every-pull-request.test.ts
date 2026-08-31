/**
 * @file ci-triggers-every-pull-request.test.ts
 * @description The gate has to run on every pull request, not just the ones
 * aimed at `main`.
 *
 * WHY THIS EXISTS
 *
 * `.github/workflows/ci.yml` carried `pull_request: branches: [ main ]` from
 * the day CI was written. That reads like a scoping nicety. What it actually
 * does is remove the gate from any pull request based on another branch — not
 * turn it red, not mark it pending: **produce no check runs at all**, which
 * looks identical to a repository where CI has not finished starting.
 *
 * Found on 2026-08-30. PR #54 was opened against #53's branch so its diff would
 * show one commit instead of two. Zero checks. Retargeting it at `main` did not
 * help either, because changing a base fires `edited` and the default trigger
 * types are `opened`, `synchronize` and `reopened`. It was tested only because
 * an unrelated force-push to fix commit authorship happened to fire
 * `synchronize`. Without that accident it could have been reviewed and merged
 * having never been built.
 *
 * That is the same shape as the 2026-08-25 finding that `database-tests`,
 * `deploy-scripts` and `docker-build` were not on the required-checks list: a
 * check everyone believes is running, that isn't. Both failures are invisible
 * in the one place people look — the PR page shows nothing wrong, because
 * nothing ran to be wrong.
 *
 * WHY A HAND PARSER AND NOT A YAML LIBRARY
 *
 * `js-yaml` resolves in this workspace today, as a transitive dependency of
 * something else. A guard that silently depends on another package's
 * dependency tree is a guard that can vanish on an unrelated lockfile change,
 * and adding it as a direct dependency edits `pnpm-lock.yaml`, which belongs to
 * the #25 lockfile PR rather than to this one.
 *
 * So this reads the block by hand, the way `no-phantom-units.test.ts` matches
 * unit names by line rather than modelling systemctl's command line. The
 * parser is narrow on purpose and it is a POSITIVE CONTROL that makes it worth
 * anything: T1 feeds it the exact text that shipped the bug and requires it to
 * say so. A checker that has never been watched fail is the same defect one
 * level up.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** Indentation depth of a line, in spaces. */
const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The `branches:` filter applied to one trigger in a workflow's `on:` block, or
 * `null` when that trigger has none.
 *
 * Handles both spellings GitHub accepts — `branches: [ main ]` and a block
 * sequence of `- main` — because a filter reintroduced in the other style would
 * be just as invisible as the one this replaced.
 *
 * Comments and blank lines are skipped rather than terminating the block: the
 * fix in `ci.yml` is a comment several lines long sitting directly above
 * `pull_request:`, and a parser that stopped at the first non-key line would
 * report "no filter" for a file that had one.
 */
export function branchFilterFor(workflow: string, trigger: string): string[] | null {
  const lines = workflow.split('\n');

  const onIndex = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIndex === -1) throw new Error('no top-level `on:` block in the workflow');

  // The trigger's own key, at any depth inside `on:` — but stop at the next
  // top-level key so a `pull_request:` appearing later in the file (inside a
  // job's `if:`, say) cannot be mistaken for the trigger.
  let start = -1;
  for (let i = onIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) === 0) break;
    if (new RegExp(`^\\s+${trigger}:\\s*$`).test(line)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const triggerIndent = indentOf(lines[start]);

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= triggerIndent) break; // dedented out of this trigger

    const inline = line.match(/^\s*branches:\s*\[(.*)\]\s*$/);
    if (inline) {
      return inline[1]
        .split(',')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }

    if (/^\s*branches:\s*$/.test(line)) {
      const items: string[] = [];
      const listIndent = indentOf(line);
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j];
        if (item.trim() === '' || item.trimStart().startsWith('#')) continue;
        if (indentOf(item) <= listIndent) break;
        const m = item.match(/^\s*-\s*(.+?)\s*$/);
        if (!m) break;
        items.push(m[1].replace(/^['"]|['"]$/g, ''));
      }
      return items;
    }
  }

  return null;
}

const BROKEN_INLINE = `name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
`;

const BROKEN_BLOCK_LIST = `name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches:
      - main
      - release/*

jobs:
  build-and-test:
    runs-on: ubuntu-latest
`;

describe('the parser can see a filter when there is one', () => {
  it('T1: reports the exact filter that removed the gate on 2026-08-30', () => {
    // POSITIVE CONTROL. Everything below is only meaningful because this
    // passes: without it, a parser that returned null unconditionally would
    // make the whole file green while enforcing nothing.
    expect(branchFilterFor(BROKEN_INLINE, 'pull_request')).toEqual(['main']);
  });

  it('T2: reports a filter written as a block sequence', () => {
    expect(branchFilterFor(BROKEN_BLOCK_LIST, 'pull_request')).toEqual([
      'main',
      'release/*',
    ]);
  });

  it('T3: does not mistake push’s filter for pull_request’s', () => {
    const onlyPushFiltered = BROKEN_INLINE.replace('  pull_request:\n    branches: [ main ]\n', '  pull_request:\n');
    expect(branchFilterFor(onlyPushFiltered, 'push')).toEqual(['main']);
    expect(branchFilterFor(onlyPushFiltered, 'pull_request')).toBeNull();
  });

  it('T4: is not fooled by comments between the trigger and its keys', () => {
    const commented = `on:
  # a comment that used to end the block early
  pull_request:
    # and another
    branches: [ main ]
`;
    expect(branchFilterFor(commented, 'pull_request')).toEqual(['main']);
  });
});

describe('the workflow in this checkout', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('T5: runs on every pull request, whatever its base branch', () => {
    // A stacked pull request — one based on another feature branch — is a
    // normal thing to open here, and it must be gated like any other.
    expect(
      branchFilterFor(workflow, 'pull_request'),
      'ci.yml must not filter `pull_request` by branch; see this file’s header'
    ).toBeNull();
  });

  it('T6: still builds `main` on push, and only `main`', () => {
    // The other half of the trade. Without this, every branch push builds as
    // well as every pull request, and the queue doubles for nothing.
    expect(branchFilterFor(workflow, 'push')).toEqual(['main']);
  });
});
