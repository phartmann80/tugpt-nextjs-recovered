import { describe, expect, it } from 'vitest';
import { metadata } from '../src/app/layout';
import { APP_CONFIG } from '../src/config/locales';

describe('TuGPT.ai Product Identity & Localization Config', () => {
  it('has the correct product name and identity metadata', () => {
    expect(APP_CONFIG.name).toBe('TuGPT.ai');
    expect(metadata.title).toBe('TuGPT.ai');
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
