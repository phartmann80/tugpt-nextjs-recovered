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

describe('DraftOrchestrator', () => {
  // T1: Logicc success — primary returns valid response, fallback never called
  it('returns success when primary provider succeeds', async () => {
    const primary = createMockAdapter('logicc', 'success');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('logicc');
      expect(result.result.text).toBe('This is a valid draft response.');
    }
    expect(fallback.calls).toBe(0);
  });

  // T2: Logicc transient failure → Langdock success
  it('falls back to Langdock when Logicc returns HTTP 500', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
    expect(fallback.calls).toBe(1);
  });

  // T3: Logicc transient failure → Langdock failure
  it('returns failure when both providers fail with HTTP 500', async () => {
    const primary = createMockAdapter('logicc', 'fail-500');
    const fallback = createMockAdapter('langdock', 'fail-500');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_5XX');
    }
  });

  // T4: No fallback on 400
  it('does not fall back on HTTP 400', async () => {
    const primary = createMockAdapter('logicc', 'fail-400');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_400');
    }
    expect(fallback.calls).toBe(0);
  });

  // T5: No fallback on 401
  it('does not fall back on HTTP 401', async () => {
    const primary = createMockAdapter('logicc', 'fail-401');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_401');
    }
    expect(fallback.calls).toBe(0);
  });

  // T6: No fallback on 403
  it('does not fall back on HTTP 403', async () => {
    const primary = createMockAdapter('logicc', 'fail-403');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_403');
    }
    expect(fallback.calls).toBe(0);
  });

  // T7: No fallback on 404
  it('does not fall back on HTTP 404', async () => {
    const primary = createMockAdapter('logicc', 'fail-404');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_404');
    }
    expect(fallback.calls).toBe(0);
  });

  // T8: No fallback on 422
  it('does not fall back on HTTP 422', async () => {
    const primary = createMockAdapter('logicc', 'fail-422');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('HTTP_422');
    }
    expect(fallback.calls).toBe(0);
  });

  // T9: No fallback on invalid configuration
  it('does not fall back on invalid configuration', async () => {
    const primary = createMockAdapter('logicc', 'invalid-config');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('INVALID_CONFIGURATION');
    }
    expect(fallback.calls).toBe(0);
  });

  // T10: No fallback on malformed provider response
  it('does not fall back on malformed provider response', async () => {
    const primary = createMockAdapter('logicc', 'malformed');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('MALFORMED_PROVIDER_RESPONSE');
    }
    expect(fallback.calls).toBe(0);
  });

  // T11: 25-second timeout — primary aborts, fallback called
  it('falls back when primary times out', async () => {
    const primary = createMockAdapter('logicc', 'timeout');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
    expect(fallback.calls).toBe(1);
  });

  // T12: Empty provider output — no fallback
  it('returns EMPTY_OUTPUT error when primary returns empty text', async () => {
    const primary = createMockAdapter('logicc', 'empty');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('EMPTY_OUTPUT');
    }
    expect(fallback.calls).toBe(0);
  });

  // T13: Oversized provider output — no fallback
  it('returns OUTPUT_TOO_LONG error when primary returns oversized text', async () => {
    const primary = createMockAdapter('logicc', 'oversized');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('OUTPUT_TOO_LONG');
    }
    expect(fallback.calls).toBe(0);
  });

  // T14: Network failure — fallback allowed
  it('falls back when primary has network failure', async () => {
    const primary = createMockAdapter('logicc', 'network');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });

  // T15: HTTP 408 — fallback allowed
  it('falls back when primary returns HTTP 408', async () => {
    const primary = createMockAdapter('logicc', 'fail-408');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });

  // T16: HTTP 429 — fallback allowed
  it('falls back when primary returns HTTP 429', async () => {
    const primary = createMockAdapter('logicc', 'fail-429');
    const fallback = createMockAdapter('langdock', 'success');
    const orchestrator = new DraftOrchestrator({ primary, fallback });

    const result = await orchestrator.generateDraft(defaultRequest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.provider).toBe('langdock');
    }
  });
});