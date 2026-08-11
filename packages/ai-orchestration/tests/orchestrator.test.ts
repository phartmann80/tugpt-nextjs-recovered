/**
 * @file orchestrator.test.ts
 * @description Deterministic tests for the 3-provider failover chain.
 *
 * Test matrix (per Paul's spec):
 * 1. Logicc success → Langdock not called → Anymize not called
 * 2. Logicc transient failure → Langdock success → Anymize not called
 * 3. Logicc transient → Langdock transient → Anymize success
 * 4. All three transient failures → normal worker retry lifecycle
 * 5. Logicc HTTP 429 → Langdock
 * 6. Langdock HTTP 429 → Anymize
 * 7. Logicc 400/401/403/404/422 → no fallback
 * 8. Invalid Logicc configuration → no fallback
 * 9. Invalid request → no fallback
 * 10. Anymize never called before Logicc and Langdock
 * 11. No provider keys/content in logs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DraftOrchestrator } from '../src/orchestrator.js';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';
import type { DraftRequest } from '../src/types.js';

// --- Mock adapters ---

function createMockAdapter(providerName: string): AIProviderAdapter & {
  setResponse: (response: CompletionResponse | null) => void;
  setError: (error: ProviderError | null) => void;
  getCallCount: () => number;
  reset: () => void;
} {
  let callCount = 0;
  let response: CompletionResponse | null = null;
  let error: ProviderError | null = null;

  return {
    providerName,
    async generateCompletion(
      _messages: readonly ChatMessage[],
      _options?: CompletionOptions,
    ): Promise<CompletionResponse> {
      callCount++;
      if (error) throw error;
      if (response) return response;
      throw new ProviderError(providerName, 'UNKNOWN_FAILURE');
    },
    setResponse(r: CompletionResponse | null) { response = r; },
    setError(e: ProviderError | null) { error = e; },
    getCallCount() { return callCount; },
    reset() { callCount = 0; response = null; error = null; },
  };
}

function createSuccessResponse(provider: string, model: string): CompletionResponse {
  return {
    id: 'test-id',
    provider,
    model,
    text: 'Hello! How can I help you today?',
    usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    latencyMs: 100,
  };
}

function createDraftRequest(): DraftRequest {
  return {
    sourceMessageText: 'Hi, I need help with my order',
    config: {
      businessInstructions: 'You are a helpful assistant',
      personality: 'Friendly and professional',
      responseRules: 'Always greet the customer',
      tone: 'warm',
      maxDraftLength: 500,
    },
    organizationId: 'test-org-id',
    requestId: 'test-request-id',
  };
}

// --- Tests ---

describe('DraftOrchestrator — 3-provider failover chain', () => {
  let logicc: ReturnType<typeof createMockAdapter>;
  let langdock: ReturnType<typeof createMockAdapter>;
  let anymize: ReturnType<typeof createMockAdapter>;
  let orchestrator: DraftOrchestrator;

  beforeEach(() => {
    logicc = createMockAdapter('logicc');
    langdock = createMockAdapter('langdock');
    anymize = createMockAdapter('anymize');
    orchestrator = new DraftOrchestrator({
      primary: logicc,
      fallback: langdock,
      tertiary: anymize,
    });
  });

  // Test 1: Logicc success → Langdock not called → Anymize not called
  it('Test 1: Logicc success → Langdock not called → Anymize not called', async () => {
    logicc.setResponse(createSuccessResponse('logicc', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('logicc');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 2: Logicc transient failure → Langdock success → Anymize not called
  it('Test 2: Logicc transient failure → Langdock success → Anymize not called', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_5XX', 500));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(1);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 3: Logicc transient → Langdock transient → Anymize success
  it('Test 3: Logicc transient → Langdock transient → Anymize success', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_5XX', 500));
    langdock.setError(new ProviderError('langdock', 'HTTP_5XX', 500));
    anymize.setResponse(createSuccessResponse('anymize', 'openai/gpt-5-mini'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('anymize');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(1);
    expect(anymize.getCallCount()).toBe(1);
  });

  // Test 4: All three transient failures → normal worker retry lifecycle
  it('Test 4: All three transient failures → returns failure for worker retry lifecycle', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_5XX', 500));
    langdock.setError(new ProviderError('langdock', 'HTTP_5XX', 500));
    anymize.setError(new ProviderError('anymize', 'HTTP_5XX', 500));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_5XX');
    expect(result.error?.provider).toBe('anymize');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(1);
    expect(anymize.getCallCount()).toBe(1);
  });

  // Test 5: Logicc HTTP 429 → Langdock
  it('Test 5: Logicc HTTP 429 → fallback to Langdock', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_429', 429));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(1);
  });

  // Test 6: Langdock HTTP 429 → Anymize
  it('Test 6: Langdock HTTP 429 → fallback to Anymize', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_429', 429));
    langdock.setError(new ProviderError('langdock', 'HTTP_429', 429));
    anymize.setResponse(createSuccessResponse('anymize', 'openai/gpt-5-mini'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('anymize');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(1);
    expect(anymize.getCallCount()).toBe(1);
  });

  // Test 7: Logicc 400/401/403/404/422 → no fallback
  it('Test 7a: Logicc HTTP 400 → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_400', 400));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_400');
    expect(logicc.getCallCount()).toBe(1);
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  it('Test 7b: Logicc HTTP 401 → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_401', 401));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_401');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  it('Test 7c: Logicc HTTP 403 → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_403', 403));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_403');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  it('Test 7d: Logicc HTTP 404 → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_404', 404));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_404');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  it('Test 7e: Logicc HTTP 422 → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_422', 422));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('HTTP_422');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 8: Invalid Logicc configuration → no fallback
  it('Test 8: Invalid Logicc configuration (INVALID_CONFIGURATION) → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'INVALID_CONFIGURATION'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INVALID_CONFIGURATION');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 9: Invalid request → no fallback
  it('Test 9: Invalid request (INVALID_REQUEST) → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'INVALID_REQUEST'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('INVALID_REQUEST');
    expect(langdock.getCallCount()).toBe(0);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 10: Anymize never called before Logicc and Langdock
  it('Test 10: Anymize never called before Logicc and Langdock', async () => {
    logicc.setResponse(createSuccessResponse('logicc', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(anymize.getCallCount()).toBe(0);

    // Reset and test with Logicc failure
    logicc.reset();
    logicc.setError(new ProviderError('logicc', 'HTTP_5XX', 500));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result2 = await orchestrator.generateDraft(createDraftRequest());
    expect(result2.success).toBe(true);
    expect(anymize.getCallCount()).toBe(0);
  });

  // Test 11: No provider keys/content in logs
  it('Test 11: No provider keys or customer content in console output', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const errorSpy = vi.spyOn(console, 'error');
    logicc.setResponse(createSuccessResponse('logicc', 'gpt-4'));
    await orchestrator.generateDraft(createDraftRequest());
    const allOutput = [
      ...consoleSpy.mock.calls.map(c => c.join(' ')),
      ...errorSpy.mock.calls.map(c => c.join(' ')),
    ].join(' ');
    expect(allOutput).not.toContain('apiKey');
    expect(allOutput).not.toContain('Bearer ');
    expect(allOutput).not.toContain('Hi, I need help with my order');
    expect(allOutput).not.toContain('test-org-id');
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Additional: NETWORK_FAILURE triggers fallback
  it('Extra: Logicc NETWORK_FAILURE → fallback to Langdock', async () => {
    logicc.setError(new ProviderError('logicc', 'NETWORK_FAILURE'));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
  });

  // Additional: TIMEOUT triggers fallback
  it('Extra: Logicc TIMEOUT → fallback to Langdock', async () => {
    logicc.setError(new ProviderError('logicc', 'TIMEOUT'));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
  });

  // Additional: HTTP 408 triggers fallback
  it('Extra: Logicc HTTP 408 → fallback to Langdock', async () => {
    logicc.setError(new ProviderError('logicc', 'HTTP_408', 408));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
  });

  // Additional: MALFORMED_LOCAL_INPUT does NOT trigger fallback
  it('Extra: Logicc MALFORMED_LOCAL_INPUT → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'MALFORMED_LOCAL_INPUT'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('MALFORMED_LOCAL_INPUT');
    expect(langdock.getCallCount()).toBe(0);
  });

  // Additional: UNKNOWN_FAILURE does NOT trigger fallback
  it('Extra: Logicc UNKNOWN_FAILURE → no fallback', async () => {
    logicc.setError(new ProviderError('logicc', 'UNKNOWN_FAILURE'));
    const result = await orchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe('UNKNOWN_FAILURE');
    expect(langdock.getCallCount()).toBe(0);
  });

  // Additional: 2-provider backward compatibility (no tertiary)
  it('Extra: 2-provider chain works without tertiary (backward compat)', async () => {
    const twoProviderOrchestrator = new DraftOrchestrator({
      primary: logicc,
      fallback: langdock,
    });
    logicc.setError(new ProviderError('logicc', 'HTTP_5XX', 500));
    langdock.setResponse(createSuccessResponse('langdock', 'gpt-4'));
    const result = await twoProviderOrchestrator.generateDraft(createDraftRequest());
    expect(result.success).toBe(true);
    expect(result.result?.provider).toBe('langdock');
    expect(anymize.getCallCount()).toBe(0);
  });
});