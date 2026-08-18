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
import { buildDraftOrchestrator } from '../src/draft-orchestrator-factory';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';

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
});
