import { describe, it, expect } from 'vitest';
import { DraftOrchestrator } from '../src/orchestrator';
import type { AIProviderAdapter, CompletionResponse, ChatMessage, CompletionOptions } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';
import type { DraftRequest, DraftConfig } from '../src/types';

// --- Mock helpers ---

function createMockAdapter(
  providerName: string,
  behavior: 'success' | 'fail-500' | 'fail-401' | 'fail-403' | 'fail-400' | 'fail-404' | 'fail-422' | 'fail-408' | 'fail-429' | 'timeout' | 'network' | 'empty' | 'oversized' | 'invalid-config' | 'malformed'
): AIProviderAdapter & { calls: number } {
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

describe('DraftOrchestrator — Three-Provider Chain (Logicc → Langdock → Anymize)', () => {
  // ================================================================
  // Required tests per spec
  // ================================================================

  // T1: Logicc success → Langdock not called → Anymize not called
  it('Logicc success: Langdock not called, Anymize not called', async () => {
    const primary = createMockAdapter('logicc', 'success');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('logicc');
      expect(result.result.text).toBe('This is a valid draft response.');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T2: Logicc transient failure → Langdock succeeds → Anymize not called
  it('Logicc transient failure → Langdock succeeds, Anymize not called', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(tertiary.calls).toBe(0);
  });

  // T3: Logicc transient failure → Langdock transient failure → Anymize succeeds
  it('Logicc transient failure → Langdock transient failure → Anymize succeeds', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'fail-500');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('anymize');
    }
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(tertiary.calls).toBe(1);
  });

  // T4: All three transient failures → worker enters normal retry lifecycle
  it('All three transient failures → returns transient failure', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'fail-500');
    const tertiary = createMockAdapter('anymize', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_5XX');
      expect(result.error.provider).toBe('anymize');
    }
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(tertiary.calls).toBe(1);
  });

  // T5: Logicc 429 → Langdock
  it('Logicc 429 → falls back to Langdock', async () => {
    const primary = createMockAdapter('logicc', 'fail-429');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
    expect(fallback.calls).toBe(1);
    expect(tertiary.calls).toBe(0);
  });

  // T6: Langdock 429 → Anymize
  it('Langdock 429 → falls back to Anymize', async () => {
    const primary = createMockAdapter('logicc', 'fail-429');
    const fallback = createMockAdapter('langdock', 'fail-429');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('anymize');
    }
    expect(tertiary.calls).toBe(1);
  });

  // T7: Logicc 400 → no fallback
  it('Logicc 400 → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-400');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_400');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T8: Logicc 401 → no fallback
  it('Logicc 401 → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-401');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_401');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T9: Logicc 403 → no fallback
  it('Logicc 403 → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-403');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_403');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T10: Logicc 404 → no fallback
  it('Logicc 404 → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-404');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_404');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T11: Logicc 422 → no fallback
  it('Logicc 422 → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-422');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_422');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T12: Invalid Logicc configuration → no fallback
  it('Invalid Logicc configuration → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'invalid-config');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('INVALID_CONFIGURATION');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T13: Invalid request (malformed) → no fallback
  it('Invalid request (malformed provider response) → no fallback', async () => {
    const primary = createMockAdapter('logicc', 'malformed');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('MALFORMED_PROVIDER_RESPONSE');
    }
    expect(fallback.calls).toBe(0);
    expect(tertiary.calls).toBe(0);
  });

  // T14: Anymize is never called before both Logicc and Langdock have failed with eligible transient errors
  it('Anymize is never called when Logicc succeeds', async () => {
    const primary = createMockAdapter('logicc', 'success');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    await orchestrator.generateDraft(defaultRequest);

    expect(tertiary.calls).toBe(0);
  });

  it('Anymize is never called when Langdock succeeds after Logicc transient failure', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    await orchestrator.generateDraft(defaultRequest);

    expect(tertiary.calls).toBe(0);
  });

  it('Anymize is never called when Logicc fails with non-transient error (400)', async () => {
    const primary = createMockAdapter('logicc', 'fail-400');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    await orchestrator.generateDraft(defaultRequest);

    expect(tertiary.calls).toBe(0);
    expect(fallback.calls).toBe(0);
  });

  // T15: Logicc timeout → Langdock
  it('Logicc timeout → falls back to Langdock', async () => {
    const primary = createMockAdapter('logicc', 'timeout');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });

  // T16: Logicc network failure → Langdock
  it('Logicc network failure → falls back to Langdock', async () => {
    const primary = createMockAdapter('logicc', 'network');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });

  // T17: Logicc 408 → Langdock
  it('Logicc 408 → falls back to Langdock', async () => {
    const primary = createMockAdapter('logicc', 'fail-408');
    const fallback = createMockAdapter('langdock', 'success');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });

  // T18: Langdock non-transient failure after Logicc transient → no Anymize
  it('Langdock 401 after Logicc transient → no Anymize fallback', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'fail-401');
    const tertiary = createMockAdapter('anymize', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_401');
      expect(result.error.provider).toBe('langdock');
    }
    expect(tertiary.calls).toBe(0);
  });

  // T19: Backward compatibility — no tertiary provider configured
  it('Works with only 2 providers (backward compatibility)', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_5XX');
      expect(result.error.provider).toBe('langdock');
    }
  });

  // T20: All three fail with different transient errors
  it('All three fail with different transient errors → returns last error', async () => {
    const primary = createMockAdapter('logicc', 'timeout');
    const fallback = createMockAdapter('langdock', 'network');
    const tertiary = createMockAdapter('anymize', 'fail-429');
    const orchestrator = new DraftOrchestrator({ primary, fallback, tertiary });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_429');
      expect(result.error.provider).toBe('anymize');
    }
  });

  // T21: Provider credentials and customer content must never appear in logs
  // (This is a structural test: verify that ProviderError.message is always the category string,
  // never the response body or credentials)
  it('ProviderError message is always the category string, never credentials or response body', () => {
    const error = new ProviderError('anymize', 'HTTP_5XX', 500);
    expect(error.message).toBe('HTTP_5XX');
    expect(error.message).not.toContain('key');
    expect(error.message).not.toContain('token');
    expect(error.message).not.toContain('password');
    expect(error.message).not.toContain('secret');
  });
});