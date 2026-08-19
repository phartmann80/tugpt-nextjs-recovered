/**
 * @file draft-orchestrator-factory.test.ts
 * @description Tests for the single-provider (Langdock-only) orchestrator
 * factory, added 2026-08-18 alongside the provider simplification decision
 * — see ADR-006.
 *
 * Covers:
 *   - Missing Langdock configuration throws (worker archives via the
 *     approved DRAFT_PROVIDER_CONFIG_ERROR path — see draft-worker.test.ts
 *     for that side of the behavior).
 *   - Construction succeeds with ONLY Langdock credentials present — no
 *     LOGICC_* or ANYMIZE_* env vars are required at boot, confirming the
 *     deactivated adapters impose no configuration burden.
 */
import { describe, it, expect } from 'vitest';
import { buildDraftOrchestrator, resolveLangdockModel } from '../src/draft-orchestrator-factory';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';
import { LANGDOCK_ALLOWED_MODELS } from '@tugpt/ai-providers';

describe('buildDraftOrchestrator', () => {
  it('throws when LANGDOCK_API_CODE is missing', () => {
    expect(() => buildDraftOrchestrator({} as NodeJS.ProcessEnv)).toThrow(
      'Missing Langdock provider configuration'
    );
  });

  it('builds successfully with only Langdock credentials configured', () => {
    const env = {
      LANGDOCK_API_CODE: 'test-langdock-key',
      LANGDOCK_ENDPOINT_URL: 'https://api.langdock.com/openai/eu/v1',
    } as NodeJS.ProcessEnv;

    const orchestrator = buildDraftOrchestrator(env);

    expect(orchestrator).toBeInstanceOf(DraftOrchestrator);
  });

  it('does not require LOGICC_* or ANYMIZE_* env vars — only Langdock is needed at boot', () => {
    // Deliberately absent: LOGICC_API_KEY, LOGICC_ENDPOINT_URL, ANYMIZE_API_KEY.
    // If the factory silently started requiring any of these again, this
    // test would start throwing.
    const env = { LANGDOCK_API_CODE: 'test-langdock-key' } as NodeJS.ProcessEnv;

    expect(() => buildDraftOrchestrator(env)).not.toThrow();
  });

  it('builds without LANGDOCK_ENDPOINT_URL set (adapter has its own default)', () => {
    const env = { LANGDOCK_API_CODE: 'test-langdock-key' } as NodeJS.ProcessEnv;

    expect(() => buildDraftOrchestrator(env)).not.toThrow();
  });

  it('rejects a forbidden LANGDOCK_MODEL at boot, before any request is billed', () => {
    const env = {
      LANGDOCK_API_CODE: 'test-langdock-key',
      LANGDOCK_MODEL: 'gpt-5.2-pro',
    } as NodeJS.ProcessEnv;

    expect(() => buildDraftOrchestrator(env)).toThrow(/Invalid LANGDOCK_MODEL/);
  });

  it('builds with each allowed LANGDOCK_MODEL', () => {
    for (const model of LANGDOCK_ALLOWED_MODELS) {
      const env = {
        LANGDOCK_API_CODE: 'test-langdock-key',
        LANGDOCK_MODEL: model,
      } as NodeJS.ProcessEnv;

      expect(() => buildDraftOrchestrator(env)).not.toThrow();
    }
  });
});

describe('resolveLangdockModel', () => {
  it('defaults to gpt-5-mini when LANGDOCK_MODEL is unset', () => {
    expect(resolveLangdockModel({} as NodeJS.ProcessEnv)).toBe('gpt-5-mini');
  });

  it('treats an empty or whitespace-only value as unset', () => {
    expect(resolveLangdockModel({ LANGDOCK_MODEL: '' } as NodeJS.ProcessEnv)).toBe('gpt-5-mini');
    expect(resolveLangdockModel({ LANGDOCK_MODEL: '   ' } as NodeJS.ProcessEnv)).toBe('gpt-5-mini');
  });

  it('trims surrounding whitespace, which env files pick up easily', () => {
    expect(resolveLangdockModel({ LANGDOCK_MODEL: ' gpt-5.1 ' } as NodeJS.ProcessEnv)).toBe('gpt-5.1');
  });

  it('returns each allowed model unchanged', () => {
    for (const model of LANGDOCK_ALLOWED_MODELS) {
      expect(resolveLangdockModel({ LANGDOCK_MODEL: model } as NodeJS.ProcessEnv)).toBe(model);
    }
  });

  it('rejects "auto" — Langdock returns HTTP 400 for it', () => {
    expect(() => resolveLangdockModel({ LANGDOCK_MODEL: 'auto' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid LANGDOCK_MODEL 'auto'/
    );
  });

  it('rejects every model excluded on cost grounds', () => {
    const forbidden = [
      'o3',
      'o4-mini',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.2-pro',
      'langdock-llama-3.3-70b-2',
    ];

    for (const model of forbidden) {
      expect(() => resolveLangdockModel({ LANGDOCK_MODEL: model } as NodeJS.ProcessEnv)).toThrow(
        /Invalid LANGDOCK_MODEL/
      );
    }
  });

  it('names the allowed models in the error, so the fix is obvious from the log', () => {
    expect(() => resolveLangdockModel({ LANGDOCK_MODEL: 'nope' } as NodeJS.ProcessEnv)).toThrow(
      /gpt-5-mini/
    );
  });

  it('is case-sensitive — a near-miss must fail loudly rather than silently default', () => {
    expect(() => resolveLangdockModel({ LANGDOCK_MODEL: 'GPT-5-Mini' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid LANGDOCK_MODEL/
    );
  });
});
