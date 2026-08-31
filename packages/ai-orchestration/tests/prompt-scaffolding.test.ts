/**
 * @file prompt-scaffolding.test.ts
 * @description What the type system cannot see about the per-locale prompt
 * words.
 *
 * `Record<PromptLocale, Record<GuardrailRule, string>>` already makes a missing
 * rule a compile error. Everything here is a failure that compiles:
 *
 *   - a rule present but empty;
 *   - the `{max}` placeholder lost in translation, so the model is told to
 *     write fewer than `{max}` characters;
 *   - an "English" rule that is still Spanish, because someone copied the block
 *     and translated the first three lines.
 *
 * The last one is the reason this file exists rather than a comment. The rules
 * are what stop a model inventing a price to a customer, and a half-translated
 * block is the shape a rushed second locale takes.
 */

import { describe, it, expect } from 'vitest';
import {
  GUARDRAIL_RULES,
  MAX_LENGTH_PLACEHOLDER,
  PROMPT_LOCALES,
  scaffoldingFor,
} from '../src/prompt-scaffolding';

describe('the locales this package can write a prompt in', () => {
  it('T1: has at least Spanish and English', () => {
    // A positive control for everything below: if PROMPT_LOCALES were empty,
    // every `for (const locale of ...)` loop would pass on nothing.
    expect(PROMPT_LOCALES).toContain('es');
    expect(PROMPT_LOCALES).toContain('en');
  });

  it('T2: falls back to Spanish rather than failing', () => {
    // The caller is a worker holding a job it must complete or dead-letter.
    // "I have no words for this locale" is not a reason to fail a draft.
    expect(scaffoldingFor('pt')).toEqual(scaffoldingFor('es'));
    expect(scaffoldingFor('')).toEqual(scaffoldingFor('es'));
    expect(scaffoldingFor('ES')).toEqual(scaffoldingFor('es'));
  });
});

describe('every locale', () => {
  for (const locale of PROMPT_LOCALES) {
    describe(locale, () => {
      const s = scaffoldingFor(locale);

      it(`T3: has a non-empty label for every config section`, () => {
        for (const label of [
          s.businessInstructions,
          s.personality,
          s.responseRules,
          s.tone,
          s.guardrailHeading,
        ]) {
          expect(label.trim().length).toBeGreaterThan(0);
        }
      });

      it(`T4: has a non-empty line for every guardrail rule`, () => {
        for (const rule of GUARDRAIL_RULES) {
          expect(s.rules[rule].trim().length, `${locale}.${rule} is empty`).toBeGreaterThan(10);
        }
      });

      it(`T5: keeps the {max} placeholder, and only on the length rule`, () => {
        // Renaming or dropping a placeholder compiles perfectly. This is the
        // same failure the i18n dictionaries guard against in the dashboard,
        // and it is worse here: a prompt that literally says "fewer than {max}
        // characters" is a prompt the model will try to obey.
        expect(s.rules.maxLength).toContain(MAX_LENGTH_PLACEHOLDER);

        for (const rule of GUARDRAIL_RULES) {
          if (rule === 'maxLength') continue;
          expect(s.rules[rule], `${locale}.${rule}`).not.toContain(MAX_LENGTH_PLACEHOLDER);
        }
      });
    });
  }
});

describe('the translations are actually translations', () => {
  it('T6: no rule is byte-identical between Spanish and English', () => {
    // The half-translated block. A copied line reads as done and is not.
    const es = scaffoldingFor('es');
    const en = scaffoldingFor('en');
    const same = GUARDRAIL_RULES.filter((r) => es.rules[r] === en.rules[r]);

    expect(same, 'rules that are identical in es and en').toEqual([]);
  });

  it('T7: no label is byte-identical either', () => {
    const es = scaffoldingFor('es');
    const en = scaffoldingFor('en');

    expect(es.businessInstructions).not.toBe(en.businessInstructions);
    expect(es.guardrailHeading).not.toBe(en.guardrailHeading);
  });

  it('T8: the English block does not still contain Spanish rule text', () => {
    // Stronger than T6, which a one-word edit would satisfy. These are the
    // load-bearing phrases of the Spanish rules; finding any of them inside the
    // English block means the translation was abandoned partway.
    const en = scaffoldingFor('en');
    const enBlock = Object.values(en.rules).join('\n');

    for (const phrase of [
      'Nunca inventes',
      'dato de contacto',
      'No prometas',
      'mismo idioma',
      'No afirmes ser una persona',
      'caracteres',
    ]) {
      expect(enBlock, `English rules still contain "${phrase}"`).not.toContain(phrase);
    }
  });

  it('T9: every locale still names the fabrication classes the flip produced', () => {
    // Not a paraphrase check. Hours and prices are on this list because a model
    // invented both, against a real config, on 2026-08-30. A locale whose
    // anti-invention rule forgot to mention prices is a locale that lost the
    // guardrail while appearing to have it.
    const terms: Record<string, readonly string[]> = {
      es: ['precios', 'horarios', 'disponibilidad', 'plazos', 'políticas'],
      en: ['prices', 'opening hours', 'availability', 'delivery times', 'policies'],
    };

    for (const locale of PROMPT_LOCALES) {
      const rule = scaffoldingFor(locale).rules.noInvention;
      for (const term of terms[locale]) {
        expect(rule, `${locale}.noInvention should name "${term}"`).toContain(term);
      }
    }
  });
});
