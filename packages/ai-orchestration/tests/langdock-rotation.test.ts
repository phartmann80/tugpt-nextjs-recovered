/**
 * @file langdock-rotation.test.ts
 * @description Tests for model-level rotation, added 2026-08-19.
 *
 * Each approved Langdock model has its own quota (500 requests / 250k tokens),
 * so exhausting one is a reason to use the next rather than an outage. The
 * risk in a mechanism like this is not that it fails to rotate — it is that it
 * rotates when it should not, turning one auth failure or one malformed
 * request into four, and spending three other models' quota to receive the
 * same rejection. Most of what follows pins the *non*-rotation cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LANGDOCK_ALLOWED_MODELS,
  ProviderError,
  RotatingLangdockAdapter,
  isRotatableProviderError,
  parseLangdockModelList,
  type ModelRotationEvent,
} from '@tugpt/ai-providers';

vi.mock('@tugpt/observability', () => ({
  metricsCollector: { recordProviderCall: vi.fn() },
}));

/** The real body Langdock returns for a model it does not have. */
const MODEL_REJECTION_BODY = JSON.stringify({
  error: {
    message: 'Invalid model, available models are: gpt-5-mini, gpt-5, o3',
    type: 'invalid_request_error',
  },
});

/** A 400 that is about the request, not the model. */
const REQUEST_REJECTION_BODY = JSON.stringify({
  error: { message: 'messages: field required', type: 'invalid_request_error' },
});

const QUOTA_BODY = JSON.stringify({
  error: { message: 'Rate limit reached for gpt-5-mini', type: 'rate_limit_error' },
});

/** Queue up one fetch outcome per call, in order. */
function fetchSequence(
  outcomes: Array<{ status: number; body?: string; ok?: boolean }>
): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const outcome of outcomes) {
    const isOk = outcome.ok ?? outcome.status < 400;
    mock.mockResolvedValueOnce({
      ok: isOk,
      status: outcome.status,
      text: async () => outcome.body ?? '',
      json: async () => ({
        id: 'resp-1',
        choices: [{ message: { content: 'Generated draft text.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    });
  }
  vi.stubGlobal('fetch', mock);
  return mock;
}

const OK = { status: 200 };
const modelOf = (mock: ReturnType<typeof vi.fn>, call: number): string =>
  JSON.parse((mock.mock.calls[call][1] as RequestInit).body as string).model;

// --- classification ---------------------------------------------------------

describe('isRotatableProviderError', () => {
  it('rotates on 429 — the per-model quota, which is the whole point', () => {
    expect(isRotatableProviderError(new ProviderError('langdock', 'HTTP_429', 429))).toBe(true);
  });

  it('rotates on a 400 whose detail says the model is unknown', () => {
    const err = ProviderError.fromHttpStatus(
      'langdock',
      400,
      'invalid_request_error: Invalid model, available models are: gpt-5-mini'
    );
    expect(isRotatableProviderError(err)).toBe(true);
  });

  it('does NOT rotate on a 400 about the request itself', () => {
    // Rotating here would spend every model's quota to be told the same thing.
    const err = ProviderError.fromHttpStatus(
      'langdock',
      400,
      'invalid_request_error: messages: field required'
    );
    expect(isRotatableProviderError(err)).toBe(false);
  });

  it('does NOT rotate on a 400 with no detail at all', () => {
    expect(isRotatableProviderError(ProviderError.fromHttpStatus('langdock', 400))).toBe(false);
  });

  it('does NOT rotate on account-level failures — every model would fail identically', () => {
    for (const status of [401, 403]) {
      expect(isRotatableProviderError(ProviderError.fromHttpStatus('langdock', status))).toBe(false);
    }
  });

  it('does NOT rotate on transport or gateway failures — that is what retries are for', () => {
    const categories = ['TIMEOUT', 'NETWORK_FAILURE', 'HTTP_408', 'HTTP_5XX'] as const;
    for (const category of categories) {
      expect(isRotatableProviderError(new ProviderError('langdock', category))).toBe(false);
    }
  });

  it('does NOT rotate on configuration or response-shape failures', () => {
    const categories = [
      'INVALID_CONFIGURATION',
      'INVALID_REQUEST',
      'MALFORMED_PROVIDER_RESPONSE',
      'EMPTY_OUTPUT',
      'OUTPUT_TOO_LONG',
      'UNKNOWN_FAILURE',
    ] as const;
    for (const category of categories) {
      expect(isRotatableProviderError(new ProviderError('langdock', category))).toBe(false);
    }
  });

  it('does not treat arbitrary errors as rotatable', () => {
    expect(isRotatableProviderError(new Error('boom'))).toBe(false);
    expect(isRotatableProviderError(undefined)).toBe(false);
  });
});

// --- configuration parsing --------------------------------------------------

describe('parseLangdockModelList', () => {
  it('preserves the given order, which is the rotation order', () => {
    expect(parseLangdockModelList('gpt-5.2,gpt-5-mini')).toEqual(['gpt-5.2', 'gpt-5-mini']);
  });

  it('trims whitespace, which env files pick up easily', () => {
    expect(parseLangdockModelList(' gpt-5-mini , gpt-5.1 ')).toEqual(['gpt-5-mini', 'gpt-5.1']);
  });

  it('accepts a single model — that is how rotation is turned off', () => {
    expect(parseLangdockModelList('gpt-5-mini')).toEqual(['gpt-5-mini']);
  });

  it('accepts the full allowlist', () => {
    expect(parseLangdockModelList(LANGDOCK_ALLOWED_MODELS.join(','))).toEqual([
      ...LANGDOCK_ALLOWED_MODELS,
    ]);
  });

  it('refuses a model outside the cost allowlist, wherever it appears in the list', () => {
    expect(() => parseLangdockModelList('gpt-5-mini,gpt-5.2-pro')).toThrow(ProviderError);
    expect(() => parseLangdockModelList('o3,gpt-5-mini')).toThrow(ProviderError);
  });

  it('refuses an empty list rather than silently falling back', () => {
    expect(() => parseLangdockModelList('')).toThrow(ProviderError);
    expect(() => parseLangdockModelList('  ,  ')).toThrow(ProviderError);
  });

  it('refuses duplicates — a typo that would silently halve the rotation depth', () => {
    try {
      parseLangdockModelList('gpt-5-mini,gpt-5.1,gpt-5-mini');
      expect.unreachable('should have thrown');
    } catch (err) {
      // ProviderError.message is the category by design; the human-readable
      // reason lives in providerDetail, which is what the factory surfaces.
      expect((err as ProviderError).providerDetail).toMatch(/more than once/);
    }
  });

  it('raises a terminal category, so a bad list archives instead of retrying', () => {
    try {
      parseLangdockModelList('nope');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProviderError).category).toBe('INVALID_CONFIGURATION');
    }
  });
});

// --- the adapter ------------------------------------------------------------

describe('RotatingLangdockAdapter construction', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('refuses an empty rotation list', () => {
    expect(() => new RotatingLangdockAdapter({ apiKey: 'k', models: [] })).toThrow(ProviderError);
  });

  it('refuses a forbidden model before any request is billed', () => {
    expect(
      () => new RotatingLangdockAdapter({ apiKey: 'k', models: ['gpt-5-mini', 'o3'] })
    ).toThrow(ProviderError);
  });

  it('exposes the rotation order it will use', () => {
    const adapter = new RotatingLangdockAdapter({ apiKey: 'k', models: ['gpt-5-mini', 'gpt-5.1'] });
    expect(adapter.rotationOrder).toEqual(['gpt-5-mini', 'gpt-5.1']);
  });
});

describe('RotatingLangdockAdapter behaviour', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses the first model and makes exactly one call when it succeeds', async () => {
    const fetchMock = fetchSequence([OK]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2'],
    });

    const result = await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(modelOf(fetchMock, 0)).toBe('gpt-5-mini');
    expect(result.model).toBe('gpt-5-mini');
  });

  it('rotates to the next model on 429 and reports the model that served it', async () => {
    const fetchMock = fetchSequence([{ status: 429, body: QUOTA_BODY }, OK]);
    const rotations: ModelRotationEvent[] = [];
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1'],
      onRotate: (event) => rotations.push(event),
    });

    const result = await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(modelOf(fetchMock, 0)).toBe('gpt-5-mini');
    expect(modelOf(fetchMock, 1)).toBe('gpt-5.1');
    // The draft must be attributed to the model that actually produced it.
    expect(result.model).toBe('gpt-5.1');

    expect(rotations).toHaveLength(1);
    expect(rotations[0].from).toBe('gpt-5-mini');
    expect(rotations[0].to).toBe('gpt-5.1');
    expect(rotations[0].category).toBe('HTTP_429');
    expect(rotations[0].attempt).toBe(1);
    expect(rotations[0].total).toBe(2);
  });

  it('rotates through several models until one answers', async () => {
    const fetchMock = fetchSequence([
      { status: 429, body: QUOTA_BODY },
      { status: 429, body: QUOTA_BODY },
      OK,
    ]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5'],
    });

    const result = await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.model).toBe('gpt-5.2');
  });

  it('rotates past a model the provider no longer offers', async () => {
    const fetchMock = fetchSequence([{ status: 400, body: MODEL_REJECTION_BODY }, OK]);
    const adapter = new RotatingLangdockAdapter({ apiKey: 'k', models: ['gpt-5.2', 'gpt-5-mini'] });

    const result = await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe('gpt-5-mini');
  });

  it('does NOT rotate on a malformed request — one call, error unchanged', async () => {
    const fetchMock = fetchSequence([{ status: 400, body: REQUEST_REJECTION_BODY }]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2'],
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ category: 'HTTP_400' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT rotate on an auth failure — that would be four auth failures', async () => {
    const fetchMock = fetchSequence([{ status: 401 }]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1'],
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ category: 'HTTP_401' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT rotate on a 5xx — the worker retries those on its own schedule', async () => {
    const fetchMock = fetchSequence([{ status: 503 }]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1'],
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ category: 'HTTP_5XX' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the category when every model is exhausted, and says so', async () => {
    // All four rate limited is still HTTP_429: still transient, still worth
    // retrying later, because the quotas reset. Rotation must not change the
    // worker's transient/terminal verdict.
    const fetchMock = fetchSequence([
      { status: 429, body: QUOTA_BODY },
      { status: 429, body: QUOTA_BODY },
      { status: 429, body: QUOTA_BODY },
    ]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2'],
    });

    try {
      await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      const providerError = err as ProviderError;
      expect(providerError.category).toBe('HTTP_429');
      expect(providerError.httpStatus).toBe(429);
      // Otherwise a total quota exhaustion is indistinguishable in the
      // dead-letter record from one model being briefly rate limited.
      expect(providerError.providerDetail).toContain('3 model(s) exhausted');
      expect(providerError.providerDetail).toContain('gpt-5-mini -> gpt-5.1 -> gpt-5.2');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours an explicit per-call model and does not rotate away from it', async () => {
    const fetchMock = fetchSequence([{ status: 429, body: QUOTA_BODY }]);
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1'],
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }], { model: 'gpt-5.2' })
    ).rejects.toMatchObject({ category: 'HTTP_429' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(modelOf(fetchMock, 0)).toBe('gpt-5.2');
  });

  it('still enforces the allowlist on a per-call override', async () => {
    const fetchMock = fetchSequence([OK]);
    const adapter = new RotatingLangdockAdapter({ apiKey: 'k', models: ['gpt-5-mini'] });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }], { model: 'gpt-5.2-pro' })
    ).rejects.toThrow(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops rotating once the caller’s budget is aborted', async () => {
    // The orchestrator wraps the whole call in one 25s AbortController, so
    // rotation shares that budget rather than multiplying it.
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        controller.abort();
        return { ok: false, status: 429, text: async () => QUOTA_BODY };
      })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'x', choices: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2'],
    });

    await expect(
      adapter.generateCompletion([{ role: 'user', content: 'hi' }], { signal: controller.signal })
    ).rejects.toMatchObject({ category: 'HTTP_429' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never calls onRotate when the first model succeeds', async () => {
    fetchSequence([OK]);
    const onRotate = vi.fn();
    const adapter = new RotatingLangdockAdapter({
      apiKey: 'k',
      models: ['gpt-5-mini', 'gpt-5.1'],
      onRotate,
    });

    await adapter.generateCompletion([{ role: 'user', content: 'hi' }]);

    expect(onRotate).not.toHaveBeenCalled();
  });
});
