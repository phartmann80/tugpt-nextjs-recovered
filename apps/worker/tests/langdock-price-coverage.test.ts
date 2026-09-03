/**
 * The Langdock cost allowlist and the Langdock price book are two lists in two
 * languages, and nothing but this file connects them.
 *
 * `LANGDOCK_ALLOWED_MODELS` (packages/ai-providers/src/langdock.ts) is the set
 * of models TuGPT is permitted to send. Migration 20260903000005 prices them.
 * Add a fifth model to the allowlist and forget the migration and every call
 * to it records with `cost_micros` NULL — priced-unknown, forever, silently,
 * and only visible to somebody who thinks to go looking for unpriced rows.
 *
 * That is a quiet failure with a real cost attached, so it gets a mechanical
 * guard rather than a note in a document. This test reads the migration and
 * requires a row for every allowlisted model on both token dimensions.
 *
 * It reads the SQL as text rather than querying a database because the unit
 * suite has no database. That makes it a coarser check than the pgTAP S6
 * assertion (which counts real rows) and a different one: S6 catches a row
 * that failed to insert, this catches a model nobody wrote a row for.
 *
 * NOTE for whoever adds the next price migration: this file names
 * 20260903000005 explicitly. A later migration that supersedes those rates
 * should be added to PRICE_MIGRATIONS below, not silently left out — the test
 * passing while the real prices moved elsewhere is the one way it can lie.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGDOCK_ALLOWED_MODELS } from '@tugpt/ai-providers';

const PRICE_MIGRATIONS = ['20260903000005_multi_currency_and_langdock_prices.sql'];

const BILLED_DIMENSIONS = ['input_tokens', 'output_tokens'] as const;

function readPriceSql(): string {
  return PRICE_MIGRATIONS.map((name) =>
    readFileSync(
      path.join(process.cwd(), '..', '..', 'supabase', 'migrations', name),
      'utf8'
    )
  ).join('\n');
}

describe('every allowlisted Langdock model has a price', () => {
  const sql = readPriceSql();

  // The seed is a VALUES list of ('<model>', '<dimension>', <rate>, '<source>')
  // rows. Matching on the pair keeps a model priced for input but not output
  // from passing.
  function isPriced(model: string, dimension: string): boolean {
    const pattern = new RegExp(
      `\\('${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*,\\s*'${dimension}'`
    );
    return pattern.test(sql);
  }

  it.each(LANGDOCK_ALLOWED_MODELS.flatMap((m) => BILLED_DIMENSIONS.map((d) => [m, d])))(
    'prices %s on %s',
    (model, dimension) => {
      expect(isPriced(model as string, dimension as string)).toBe(true);
    }
  );

  // The positive control. Without it every assertion above would pass against
  // an `isPriced` that returned true for everything — including the empty
  // string, which is the shape a bad regex actually degrades to.
  it('does not claim a price for a model that has none', () => {
    expect(isPriced('gpt-6-imaginary', 'input_tokens')).toBe(false);
    expect(isPriced('', 'input_tokens')).toBe(false);
  });

  // Guards the other direction: a price row for a model that is NOT on the
  // allowlist means either the allowlist lost an entry or somebody priced a
  // model TuGPT is not permitted to call. Both are worth a failing build.
  it('prices no model outside the allowlist', () => {
    const priced = [...sql.matchAll(/\('([a-z0-9.-]+)'\s*,\s*'(?:in|out)put_tokens'/g)].map(
      (m) => m[1]
    );
    expect(priced.length).toBeGreaterThan(0);
    expect([...new Set(priced)].sort()).toEqual([...LANGDOCK_ALLOWED_MODELS].sort());
  });
});
