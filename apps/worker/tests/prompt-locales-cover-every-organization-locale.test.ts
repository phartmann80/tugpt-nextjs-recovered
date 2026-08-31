/**
 * @file prompt-locales-cover-every-organization-locale.test.ts
 * @description The seam between "locales an organization may be set to" and
 * "locales a prompt can be written in".
 *
 * WHY IT LIVES HERE
 *
 * `@tugpt/database` owns `ORGANIZATION_LOCALES` — the TypeScript half of the
 * CHECK constraint on `organizations.locale`. `@tugpt/ai-orchestration` owns
 * `PROMPT_LOCALES` — the set it has scaffolding and non-negotiable rules for.
 * Neither package depends on the other, deliberately: prompt words are not a
 * database concern and the locale allowlist is not an orchestration concern.
 *
 * The worker is the only thing that depends on both, because it is the thing
 * that reads an organization's locale and hands it to the prompt builder. So
 * this is where the two lists can be compared, and it is the only place.
 *
 * WHAT GOES WRONG WITHOUT IT
 *
 * Adding a third locale is a four-step change: the CHECK constraint, the
 * `ORGANIZATION_LOCALES` array, the dashboard dictionary, and the prompt
 * scaffolding. The first three have guards already — the constraint has pgTAP
 * assertions, and `dictionaries.test.ts` fails on a missing dashboard
 * translation. The fourth had nothing.
 *
 * The failure is quiet by construction. `scaffoldingFor` falls back to Spanish
 * rather than throwing (a draft is not worth failing over a language lookup),
 * so an organization set to the new locale gets a Spanish prompt, replies in
 * the customer's language anyway because the guardrail says to, and looks
 * entirely fine. Nobody finds out from the product.
 */

import { describe, expect, it } from 'vitest';
import { ORGANIZATION_LOCALES, DEFAULT_ORGANIZATION_LOCALE } from '@tugpt/database';
import { PROMPT_LOCALES, scaffoldingFor } from '@tugpt/ai-orchestration';

describe('the two locale lists', () => {
  it('T1: neither list is empty (positive control)', () => {
    // Without this, "every organization locale has a prompt locale" passes
    // trivially the moment either import resolves to nothing.
    expect(ORGANIZATION_LOCALES.length).toBeGreaterThan(0);
    expect(PROMPT_LOCALES.length).toBeGreaterThan(0);
  });

  it('T2: every locale an organization may be set to can be written as a prompt', () => {
    const missing = ORGANIZATION_LOCALES.filter((l) => !PROMPT_LOCALES.includes(l));

    expect(
      missing,
      `These locales are allowed on organizations.locale but have no prompt ` +
        `scaffolding, so every draft for them would be written in ` +
        `${DEFAULT_ORGANIZATION_LOCALE} — silently. Add them to SCAFFOLDING in ` +
        `packages/ai-orchestration/src/prompt-scaffolding.ts.`
    ).toEqual([]);
  });

  it('T3: no prompt locale exists that an organization can never be set to', () => {
    // The opposite drift, and the cheaper one: dead translation work that
    // nothing reaches, kept up to date forever by people who assume it ships.
    const orphaned = PROMPT_LOCALES.filter(
      (l) => !(ORGANIZATION_LOCALES as readonly string[]).includes(l)
    );

    expect(orphaned, 'prompt locales no organization can be set to').toEqual([]);
  });

  it('T4: the product default is one of them', () => {
    expect(PROMPT_LOCALES).toContain(DEFAULT_ORGANIZATION_LOCALE);
  });

  it('T5: each one resolves to its own scaffolding, not the fallback', () => {
    // T2 compares two arrays of strings. This proves the entry behind each
    // string is real: a locale listed in PROMPT_LOCALES whose object was
    // deleted would still satisfy T2 while every draft for it silently fell
    // back to Spanish — which is the exact failure this file exists to prevent,
    // one level down.
    const fallback = scaffoldingFor('definitely-not-a-locale');

    for (const locale of ORGANIZATION_LOCALES) {
      if (locale === DEFAULT_ORGANIZATION_LOCALE) continue;
      expect(
        scaffoldingFor(locale),
        `${locale} resolves to the ${DEFAULT_ORGANIZATION_LOCALE} fallback`
      ).not.toEqual(fallback);
    }
  });
});
