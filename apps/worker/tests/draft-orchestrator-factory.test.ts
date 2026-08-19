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
import {
  buildDraftOrchestrator,
  resolveLangdockModel,
  resolveLangdockModels,
} from '../src/draft-orchestrator-factory';
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

/**
 * Model-level rotation, added 2026-08-19. The four approved models have
 * separate Langdock quotas, so exhausting one is a reason to use the next.
 *
 * The precedence rules are the part worth pinning: an ambiguous model
 * configuration is a cost-control question, and "which model did we actually
 * bill" must never depend on which of two env vars someone remembered to set.
 */
describe('resolveLangdockModels', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

  it('defaults to the whole allowlist, cheapest first, when neither var is set', () => {
    const resolution = resolveLangdockModels(env({}));
    expect(resolution.models).toEqual([...LANGDOCK_ALLOWED_MODELS]);
    expect(resolution.source).toBe('default');
    expect(resolution.models[0]).toBe('gpt-5-mini');
  });

  it('uses LANGDOCK_MODELS in the order given — that IS the rotation order', () => {
    const resolution = resolveLangdockModels(env({ LANGDOCK_MODELS: 'gpt-5.2,gpt-5-mini' }));
    expect(resolution.models).toEqual(['gpt-5.2', 'gpt-5-mini']);
    expect(resolution.source).toBe('LANGDOCK_MODELS');
  });

  it('treats LANGDOCK_MODEL as pinning one model, and says rotation is off', () => {
    const resolution = resolveLangdockModels(env({ LANGDOCK_MODEL: 'gpt-5.1' }));
    expect(resolution.models).toEqual(['gpt-5.1']);
    expect(resolution.source).toBe('LANGDOCK_MODEL');
    expect(resolution.note).toMatch(/Rotation is disabled/);
  });

  it('lets LANGDOCK_MODELS win when both are set, and reports that it did', () => {
    // A deployment that set LANGDOCK_MODEL before rotation existed must not be
    // silently half-honoured. Failing the boot instead would fire on exactly
    // the correct upgrade action, so this reports rather than throws.
    const resolution = resolveLangdockModels(
      env({ LANGDOCK_MODEL: 'gpt-5-mini', LANGDOCK_MODELS: 'gpt-5-mini,gpt-5.1' })
    );
    expect(resolution.models).toEqual(['gpt-5-mini', 'gpt-5.1']);
    expect(resolution.note).toMatch(/LANGDOCK_MODEL='gpt-5-mini' is ignored/);
  });

  it('does not complain when the two variables agree', () => {
    const resolution = resolveLangdockModels(
      env({ LANGDOCK_MODEL: 'gpt-5.2', LANGDOCK_MODELS: 'gpt-5.2' })
    );
    expect(resolution.models).toEqual(['gpt-5.2']);
    expect(resolution.note).toBeUndefined();
  });

  it('falls through to LANGDOCK_MODEL when LANGDOCK_MODELS is blank', () => {
    const resolution = resolveLangdockModels(
      env({ LANGDOCK_MODELS: '   ', LANGDOCK_MODEL: 'gpt-5.1' })
    );
    expect(resolution.models).toEqual(['gpt-5.1']);
    expect(resolution.source).toBe('LANGDOCK_MODEL');
  });

  it('rejects a forbidden model anywhere in LANGDOCK_MODELS', () => {
    expect(() =>
      resolveLangdockModels(env({ LANGDOCK_MODELS: 'gpt-5-mini,gpt-5.2-pro' }))
    ).toThrow(/Invalid LANGDOCK_MODELS/);
    expect(() => resolveLangdockModels(env({ LANGDOCK_MODELS: 'o3' }))).toThrow(
      /Invalid LANGDOCK_MODELS/
    );
  });

  it('rejects a duplicated model, and says why', () => {
    expect(() =>
      resolveLangdockModels(env({ LANGDOCK_MODELS: 'gpt-5-mini,gpt-5-mini' }))
    ).toThrow(/more than once/);
  });

  it('names the allowed models in the error, so the fix is obvious from the log', () => {
    expect(() => resolveLangdockModels(env({ LANGDOCK_MODELS: 'nope' }))).toThrow(/gpt-5-mini/);
  });

  it('reports the first model as the one that will actually be tried', () => {
    expect(resolveLangdockModel(env({ LANGDOCK_MODELS: 'gpt-5.2,gpt-5-mini' }))).toBe('gpt-5.2');
  });
});

describe('buildDraftOrchestrator with rotation', () => {
  it('builds with a multi-model LANGDOCK_MODELS', () => {
    const env = {
      LANGDOCK_API_CODE: 'test-langdock-key',
      LANGDOCK_MODELS: LANGDOCK_ALLOWED_MODELS.join(','),
    } as NodeJS.ProcessEnv;

    expect(() => buildDraftOrchestrator(env)).not.toThrow();
  });

  it('refuses to build with a forbidden model in the rotation list', () => {
    const env = {
      LANGDOCK_API_CODE: 'test-langdock-key',
      LANGDOCK_MODELS: 'gpt-5-mini,o4-mini',
    } as NodeJS.ProcessEnv;

    expect(() => buildDraftOrchestrator(env)).toThrow(/Invalid LANGDOCK_MODELS/);
  });
});
