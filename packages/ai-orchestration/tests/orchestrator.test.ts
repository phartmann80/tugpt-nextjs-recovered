/**
 * @file orchestrator.test.ts
 * @description DraftOrchestrator tests.
 *
 * Reworked 2026-08-18 for the single-provider (Langdock-only) architecture
 * — see ADR-006. Production wiring (apps/worker/src/draft-orchestrator-factory.ts)
 * configures only `primary`; no `fallback`/`tertiary`. The "single-provider
 * mode" describe block below is the primary coverage and matches production.
 *
 * The "fallback-capable (reintroduction)" describe block is reduced,
 * generic-naming coverage proving DraftOrchestrator still correctly chains
 * to a fallback/tertiary when configured — kept so the capability to
 * reintroduce a fallback provider later (per ADR-006) doesn't silently
 * regress, even though nothing in production configures it today. The
 * three-provider-chain-specific test suite (orchestrator-three-provider.test.ts,
 * written for the retired Logicc → Langdock → Anymize chain) was removed
 * rather than reworked, since its scenarios are now redundant with this
 * reduced fallback-capability coverage.
 */
import { describe, it, expect } from 'vitest';
import { DraftOrchestrator } from '../src/orchestrator';
import type { AIProviderAdapter, CompletionResponse, ChatMessage, CompletionOptions } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';
import type { DraftRequest, DraftConfig } from '../src/types';

// --- Mock helpers ---

type Behavior =
  | 'success'
  | 'fail-500'
  | 'fail-401'
  | 'fail-403'
  | 'fail-400'
  | 'fail-404'
  | 'fail-422'
  | 'fail-408'
  | 'fail-429'
  | 'timeout'
  | 'network'
  | 'empty'
  | 'oversized'
  | 'invalid-config'
  | 'malformed';

function createMockAdapter(providerName: string, behavior: Behavior): AIProviderAdapter & { calls: number } {
  let calls = 0;

  const adapter: AIProviderAdapter & { calls: number } = {
    providerName,
    calls: 0,
    async generateCompletion(
      _messages: readonly ChatMessage[],
      _options?: CompletionOptions
    ): Promise<CompletionResponse> {
      calls++;
      adapter.calls = calls;

      switch (behavior) {
        case 'success':
          return {
            id: 'test-id',
            provider: providerName,
            model: 'test-model',
            text: 'This is a valid draft response.',
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            latencyMs: 100,
          };
        case 'fail-500':
          throw new ProviderError(providerName, 'HTTP_5XX', 500);
        case 'fail-401':
          throw new ProviderError(providerName, 'HTTP_401', 401);
        case 'fail-403':
          throw new ProviderError(providerName, 'HTTP_403', 403);
        case 'fail-400':
          throw new ProviderError(providerName, 'HTTP_400', 400);
        case 'fail-404':
          throw new ProviderError(providerName, 'HTTP_404', 404);
        case 'fail-422':
          throw new ProviderError(providerName, 'HTTP_422', 422);
        case 'fail-408':
          throw new ProviderError(providerName, 'HTTP_408', 408);
        case 'fail-429':
          throw new ProviderError(providerName, 'HTTP_429', 429);
        case 'timeout':
          throw new ProviderError(providerName, 'TIMEOUT');
        case 'network':
          throw new ProviderError(providerName, 'NETWORK_FAILURE');
        case 'empty':
          return {
            id: 'test-id',
            provider: providerName,
            model: 'test-model',
            text: '',
            usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
            latencyMs: 100,
          };
        case 'oversized':
          return {
            id: 'test-id',
            provider: providerName,
            model: 'test-model',
            text: 'A'.repeat(2000),
            usage: { promptTokens: 10, completionTokens: 2000, totalTokens: 2010 },
            latencyMs: 100,
          };
        case 'invalid-config':
          throw new ProviderError(providerName, 'INVALID_CONFIGURATION');
        case 'malformed':
          throw new ProviderError(providerName, 'MALFORMED_PROVIDER_RESPONSE');
        default:
          throw new Error('Unknown behavior');
      }
    },
  };

  return adapter;
}

const defaultConfig: DraftConfig = {
  businessInstructions: 'Be helpful and concise.',
  personality: 'Professional and friendly.',
  responseRules: 'Always greet the customer.',
  tone: 'Warm',
  maxDraftLength: 1000,
};

const defaultRequest: DraftRequest = {
  sourceMessageText: 'Hello, I have a question about your services.',
  config: defaultConfig,
  organizationId: 'org-123',
  requestId: 'req-456',
};

describe('DraftOrchestrator — single-provider mode (production configuration)', () => {
  it('returns success when the sole provider succeeds', async () => {
    const primary = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
      expect(result.result.text).toBe('This is a valid draft response.');
    }
    expect(primary.calls).toBe(1);
  });

  it('returns the error unchanged on a transient failure (HTTP 5xx) — no next provider to hand off to', async () => {
    const primary = createMockAdapter('langdock', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_5XX');
      expect(result.error.provider).toBe('langdock');
    }
    expect(primary.calls).toBe(1);
  });

  it('returns the error unchanged on a timeout', async () => {
    const primary = createMockAdapter('langdock', 'timeout');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('TIMEOUT');
    }
  });

  it('returns the error unchanged on a network failure', async () => {
    const primary = createMockAdapter('langdock', 'network');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('NETWORK_FAILURE');
    }
  });

  it('returns the error unchanged on HTTP 429 (rate limited)', async () => {
    const primary = createMockAdapter('langdock', 'fail-429');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_429');
    }
  });

  it('returns the error unchanged on a terminal failure (HTTP 401) — same outcome as a transient one, since there is nowhere to fall back to', async () => {
    const primary = createMockAdapter('langdock', 'fail-401');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_401');
    }
  });

  it('returns EMPTY_OUTPUT when the sole provider returns empty text', async () => {
    const primary = createMockAdapter('langdock', 'empty');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('EMPTY_OUTPUT');
    }
  });

  it('returns OUTPUT_TOO_LONG when the sole provider returns oversized text', async () => {
    const primary = createMockAdapter('langdock', 'oversized');
    const orchestrator = new DraftOrchestrator({ primary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('OUTPUT_TOO_LONG');
    }
  });
});

describe('DraftOrchestrator — fallback-capable (reintroduction coverage, not used in production)', () => {
  it('does not call fallback when primary succeeds', async () => {
    const primary = createMockAdapter('primary-provider', 'success');
    const fallback = createMockAdapter('fallback-provider', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('primary-provider');
    }
    expect(fallback.calls).toBe(0);
  });

  it('falls back on a transient primary failure (HTTP 500)', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-500');
    const fallback = createMockAdapter('fallback-provider', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('fallback-provider');
    }
    expect(fallback.calls).toBe(1);
  });

  it('does not fall back on a terminal primary failure (HTTP 400)', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-400');
    const fallback = createMockAdapter('fallback-provider', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_400');
    }
    expect(fallback.calls).toBe(0);
  });

  it('returns failure when both primary and fallback fail', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-500');
    const fallback = createMockAdapter('fallback-provider', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_5XX');
      expect(result.error.provider).toBe('fallback-provider');
    }
  });

  it('chains through to tertiary when both primary and fallback fail transiently', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-500');
    const fallback = createMockAdapter('fallback-provider', 'fail-500');
    const tertiary = createMockAdapter('tertiary-provider', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('tertiary-provider');
    }
    expect(tertiary.calls).toBe(1);
  });

  it('does not call tertiary when fallback fails terminally', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-500');
    const fallback = createMockAdapter('fallback-provider', 'fail-401');
    const tertiary = createMockAdapter('tertiary-provider', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_401');
      expect(result.error.provider).toBe('fallback-provider');
    }
    expect(tertiary.calls).toBe(0);
  });

  it('works with only two providers configured (no tertiary)', async () => {
    const primary = createMockAdapter('primary-provider', 'fail-500');
    const fallback = createMockAdapter('fallback-provider', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.provider).toBe('fallback-provider');
    }
  });
});

describe('ProviderError — content privacy', () => {
  it('message is always the category string, never credentials or response body', () => {
    const error = new ProviderError('langdock', 'HTTP_5XX', 500);
    expect(error.message).toBe('HTTP_5XX');
    expect(error.message).not.toContain('key');
    expect(error.message).not.toContain('token');
    expect(error.message).not.toContain('password');
    expect(error.message).not.toContain('secret');
  });
});
