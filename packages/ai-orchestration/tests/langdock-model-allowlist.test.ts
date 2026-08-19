/**
 * @file langdock-model-allowlist.test.ts
 * @description Tests for the Langdock model allowlist, added 2026-08-19.
 *
 * Replaces langdock-adapter.test.ts's `auto` coverage. Langdock's
 * OpenAI-compatible endpoint does not support `model: "auto"` — it returns
 * HTTP 400 with the list of real models — so the former default was never
 * going to work. The allowlist is also a hard cost control: TuGPT moved to
 * Langdock after cutting a provider for cost, and only four models are
 * approved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LangdockAdapter,
  LANGDOCK_ALLOWED_MODELS,
  LANGDOCK_DEFAULT_MODEL,
  isAllowedLangdockModel,
  assertAllowedLangdockModel,
  ProviderError,
} from '@tugpt/ai-providers';

vi.mock('@tugpt/observability', () => ({
  metricsCollector: { recordProviderCall: vi.fn() },
}));

function mockSuccessfulFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'resp-1',
      choices: [{ message: { content: 'Generated draft text.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Models Langdock offers that are excluded on cost grounds. */
const FORBIDDEN_MODELS = [
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

describe('the allowlist itself', () => {
  it('contains exactly the four approved models', () => {
    expect([...LANGDOCK_ALLOWED_MODELS].sort()).toEqual(
      ['gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.2'].sort()
    );
  });

  it('defaults to the cost-conscious model', () => {
    expect(LANGDOCK_DEFAULT_MODEL).toBe('gpt-5-mini');
    expect(isAllowedLangdockModel(LANGDOCK_DEFAULT_MODEL)).toBe(true);
  });

  it('rejects every forbidden Langdock model', () => {
    for (const model of FORBIDDEN_MODELS) {
      expect(isAllowedLangdockModel(model)).toBe(false);
    }
  });

  it('rejects "auto", which Langdock does not support', () => {
    expect(isAllowedLangdockModel('auto')).toBe(false);
  });

  it('assertAllowedLangdockModel throws a terminal INVALID_CONFIGURATION', () => {
    try {
      assertAllowedLangdockModel('o3');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).category).toBe('INVALID_CONFIGURATION');
      expect((err as ProviderError).providerDetail).toContain('not on the TuGPT Langdock allowlist');
    }
  });
});

describe('LangdockAdapter model handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the default model when none is configured', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).model).toBe('gpt-5-mini');
  });

  it('never sends "auto"', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).model).not.toBe('auto');
  });

  it('accepts each allowed model', async () => {
    for (const model of LANGDOCK_ALLOWED_MODELS) {
      const fetchMock = mockSuccessfulFetch();
      const adapter = new LangdockAdapter({ apiKey: 'test-key', defaultModel: model });
      const result = await adapter.generateCompletion([{ role: 'user', content: 'Hi' }]);
      expect(result.model).toBe(model);
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(requestInit.body as string).model).toBe(model);
      vi.restoreAllMocks();
    }
  });

  it('refuses to construct with a forbidden model, before any request is billed', () => {
    for (const model of FORBIDDEN_MODELS) {
      expect(() => new LangdockAdapter({ apiKey: 'test-key', defaultModel: model })).toThrow(
        ProviderError
      );
    }
  });

  it('refuses to construct with "auto"', () => {
    expect(() => new LangdockAdapter({ apiKey: 'test-key', defaultModel: 'auto' })).toThrow(
      ProviderError
    );
  });

  it('refuses a per-call model override outside the allowlist, and makes no request', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'Hello' }], { model: 'gpt-5.2-pro' })
    ).rejects.toThrow(ProviderError);

    // The allowlist must be enforced before the network call, not after.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a per-call override that is on the allowlist', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await adapter.generateCompletion([{ role: 'user', content: 'Hello' }], { model: 'gpt-5.2' });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).model).toBe('gpt-5.2');
  });
});

describe('LangdockAdapter surfaces the provider error on failure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the provider message from a 400 and classifies it HTTP_400', async () => {
    // The exact failure from the 2026-08-19 run.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message: 'Invalid model, available models are: gpt-5-mini, gpt-5, o3',
              type: 'invalid_request_error',
            },
          }),
      })
    );

    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    try {
      await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.category).toBe('HTTP_400');
      expect(providerError.httpStatus).toBe(400);
      expect(providerError.providerDetail).toContain('Invalid model');
    }
  });

  it('still raises the HTTP error when the body cannot be read', async () => {
    // Reading the body for detail must never mask the failure itself.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => {
          throw new Error('stream already consumed');
        },
      })
    );

    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    try {
      await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProviderError).category).toBe('HTTP_429');
      expect((err as ProviderError).providerDetail).toBeUndefined();
    }
  });
});
