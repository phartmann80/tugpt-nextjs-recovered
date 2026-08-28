import { describe, expect, it } from 'vitest';
import { metadata } from '../src/app/layout';
import { APP_CONFIG } from '../src/config/locales';

describe('TuGPT Product Identity & Localization Config', () => {
  it('has the correct product name and identity metadata', () => {
    // No TLD in the product name. The old domain was lost on 2026-08-28 and
    // the brand had carried it into the browser tab; tugpt.app is a hostname,
    // not an identity. apps/worker/tests/no-dead-domain.test.ts keeps the dead
    // one from returning — including from a comment like this one.
    expect(APP_CONFIG.name).toBe('TuGPT');
    expect(metadata.title).toBe('TuGPT');
  });

  it('configures Spanish as the primary default language', () => {
    expect(APP_CONFIG.primaryLocale).toBe('es');
  });

  it('supports Spanish as primary and English as secondary language', () => {
    expect(APP_CONFIG.supportedLocales).toContain('es');
    expect(APP_CONFIG.supportedLocales).toContain('en');
    expect(APP_CONFIG.secondaryLocale).toBe('en');
  });
});
