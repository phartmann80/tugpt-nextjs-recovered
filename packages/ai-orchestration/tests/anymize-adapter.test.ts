/**
 * @file anymize-adapter.test.ts
 * @description Deterministic tests for AnymizeAdapter response handling.
 *
 * Specifically tests that malformed 2xx responses (unparseable JSON,
 * invalid response shape) are classified as MALFORMED_PROVIDER_RESPONSE
 * (terminal), not NETWORK_FAILURE (transient).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnymizeAdapter } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';

// Mock the metricsCollector so we don't need the real observability package
vi.mock('@tugpt/observability', () => ({
  metricsCollector: {
    recordProviderCall: vi.fn(),
  },
}));

describe('AnymizeAdapter — malformed response classification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const validConfig = {
    apiKey: 'test-key',
    endpointUrl: 'https://app.anymize.ai/api/v1/llm',
    defaultModel: 'test-model',
  };

  it('2xx with unparseable JSON → MALFORMED_PROVIDER_RESPONSE (terminal)', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token in JSON');
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({
      provider: 'anymize',
      category: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it('2xx with missing choices array → MALFORMED_PROVIDER_RESPONSE', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'resp-1' }), // no choices field
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({
      provider: 'anymize',
      category: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it('2xx with empty choices array → MALFORMED_PROVIDER_RESPONSE', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'resp-1', choices: [] }),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({
      provider: 'anymize',
      category: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it('2xx with choices but missing message.content → MALFORMED_PROVIDER_RESPONSE', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp-1',
        choices: [{ message: {} }], // no content field
      }),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({
      provider: 'anymize',
      category: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it('2xx with valid response → succeeds normally', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp-1',
        choices: [{ message: { content: 'Generated draft text.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    const result = await adapter.generateCompletion([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.provider).toBe('anymize');
    expect(result.text).toBe('Generated draft text.');
    expect(result.usage.totalTokens).toBe(30);
  });

  it('MALFORMED_PROVIDER_RESPONSE is not NETWORK_FAILURE (must be terminal)', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const adapter = new AnymizeAdapter(validConfig);

    try {
      await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.category).toBe('MALFORMED_PROVIDER_RESPONSE');
      expect(pe.category).not.toBe('NETWORK_FAILURE');
    }
  });

  it('missing model (no default, no options) → INVALID_CONFIGURATION', async () => {
    const adapter = new AnymizeAdapter({
      apiKey: 'test-key',
      endpointUrl: 'https://app.anymize.ai/api/v1/llm',
      // no defaultModel
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({
      provider: 'anymize',
      category: 'INVALID_CONFIGURATION',
    });
  });
});