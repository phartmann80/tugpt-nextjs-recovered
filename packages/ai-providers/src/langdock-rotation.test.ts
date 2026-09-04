/**
 * @file langdock-rotation.test.ts
 * @description Tests for the decision "spend the next model's quota".
 *
 * WHAT IS AT STAKE
 *
 * Rotation is what replaced provider-level failover when Langdock became the
 * sole provider. It is deliberately narrow, and the narrowness is the whole
 * design: rotating on the wrong error turns one failure into four, burning
 * four quotas to receive the same rejection four times.
 *
 * So the tests are organised around the boundary rather than the happy path.
 * For every category that MUST rotate there is a paired category that MUST
 * NOT, run through the same adapter with the same fixture — because "it did
 * not rotate" is only meaningful next to a case where it did.
 *
 * THE TWO CLAIMS THAT COST MONEY IF WRONG
 *
 *   - A 400 rotates only when the provider's own detail says the complaint is
 *     about the model. A 400 about our malformed request rotating would spend
 *     every model's quota to be told the same thing.
 *   - Exhaustion preserves the category and HTTP status. The worker decides
 *     transient vs terminal from the category alone
 *     (apps/worker/src/draft-rpc-error-codes.ts), so four models rate-limited
 *     must still read as HTTP_429 — still transient, still worth retrying
 *     later, because the quotas reset. Downgrading it to UNKNOWN_FAILURE
 *     would archive a job that was only ever temporarily out of capacity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metricsCollector } from '@tugpt/observability';
import {
  RotatingLangdockAdapter,
  isRotatableProviderError,
  parseLangdockModelList,
  type ModelRotationEvent,
} from './langdock-rotation';
import { LANGDOCK_ALLOWED_MODELS } from './langdock';
import { ProviderError } from './errors';

const KEY = 'langdock-test-key';
const MESSAGES = [{ role: 'user' as const, content: 'Buenos días' }];
const ALL = [...LANGDOCK_ALLOWED_MODELS];

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ok = () => json({ id: 'cmpl-1', choices: [{ message: { content: 'hola' } }] });
const err = (status: number, message = 'nope', type?: string) =>
  json({ error: { message, ...(type ? { type } : {}) } }, status);

/** What Langdock returns when a model leaves its catalogue. */
const modelGone = () => err(400, 'Invalid model, available models are: gpt-5', 'invalid_request_error');

/**
 * Hand every attempt a FRESH Response.
 *
 * `mockResolvedValue(err(429))` gives every call the SAME Response instance,
 * and a body can be read only once — so from the second attempt onward the
 * adapter's `response.text()` throws, its inner try/catch degrades the detail
 * to undefined, and assertions about what the LAST model said quietly become
 * assertions about nothing. Rotation makes up to four attempts, so this is not
 * a nicety: it is the difference between the exhaustion test reading the
 * provider's complaint and reading a read-after-consume artifact.
 */
function always(factory: () => Response): void {
  fetchMock.mockImplementation(() => Promise.resolve(factory()));
}

/** Model actually sent on each fetch call, in order. */
function modelsTried(): string[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).model);
}

function rotating(overrides: Partial<{ models: readonly string[]; onRotate: (e: ModelRotationEvent) => void }> = {}) {
  return new RotatingLangdockAdapter({ apiKey: KEY, models: ALL, ...overrides });
}

async function expectRejection(promise: Promise<unknown>, category: string): Promise<ProviderError> {
  try {
    await promise;
    expect.unreachable(`expected a ${category} rejection`);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    const error = e as ProviderError;
    expect(error.category).toBe(category);
    return error;
  }
  throw new Error('unreachable');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  metricsCollector.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  metricsCollector.clear();
});

// ===========================================================================
// isRotatableProviderError — the boundary, stated directly
// ===========================================================================

describe('isRotatableProviderError', () => {
  it('rotates on 429, the case it exists for', () => {
    expect(isRotatableProviderError(new ProviderError('langdock', 'HTTP_429', 429))).toBe(true);
  });

  it.each([
    'HTTP_401',
    'HTTP_403',
    'HTTP_404',
    'HTTP_408',
    'HTTP_422',
    'HTTP_5XX',
    'TIMEOUT',
    'NETWORK_FAILURE',
    'INVALID_CONFIGURATION',
    'MALFORMED_PROVIDER_RESPONSE',
    'UNKNOWN_FAILURE',
  ] as const)('does not rotate on %s', (category) => {
    // 401/403 are account-level: every model fails identically, so rotating
    // turns one auth failure into four. Timeouts, 5xx and network failures are
    // transport-level; the worker's retry policy already covers them.
    expect(isRotatableProviderError(new ProviderError('langdock', category))).toBe(false);
  });

  it.each([
    'Invalid model, available models are: gpt-5',
    'unknown model requested',
    'model not found',
    'no such model',
    'model gpt-5.9 does not exist',
    'model gpt-5.9 is not available',
  ])('rotates on a 400 whose detail says %j', (detail) => {
    expect(isRotatableProviderError(new ProviderError('langdock', 'HTTP_400', 400, detail))).toBe(true);
  });

  it.each([
    'messages must be a non-empty array',
    'temperature must be between 0 and 2',
    'context length exceeded',
  ])('does not rotate on a 400 whose detail says %j', (detail) => {
    // Our own malformed request. Rotating would burn every quota to be told
    // the same thing four times.
    expect(isRotatableProviderError(new ProviderError('langdock', 'HTTP_400', 400, detail))).toBe(false);
  });

  it('does not rotate on a 400 with no detail at all', () => {
    // Silence is not evidence the model was the problem.
    expect(isRotatableProviderError(new ProviderError('langdock', 'HTTP_400', 400))).toBe(false);
  });

  it('ignores anything that is not a ProviderError', () => {
    expect(isRotatableProviderError(new Error('Invalid model'))).toBe(false);
    expect(isRotatableProviderError('HTTP_429')).toBe(false);
    expect(isRotatableProviderError(undefined)).toBe(false);
    expect(isRotatableProviderError(null)).toBe(false);
  });
});

// ===========================================================================
// parseLangdockModelList
// ===========================================================================

describe('parseLangdockModelList', () => {
  it('parses an ordered list and preserves the order', () => {
    expect(parseLangdockModelList('gpt-5.2, gpt-5-mini ,gpt-5')).toEqual(['gpt-5.2', 'gpt-5-mini', 'gpt-5']);
  });

  it('tolerates stray separators and whitespace', () => {
    expect(parseLangdockModelList('  gpt-5-mini , , gpt-5.1 ,  ')).toEqual(['gpt-5-mini', 'gpt-5.1']);
  });

  it('accepts a single model, which is how a deployment pins one', () => {
    expect(parseLangdockModelList('gpt-5.1')).toEqual(['gpt-5.1']);
  });

  it.each(['', '   ', ',', ' , , '])('refuses %j as empty', (raw) => {
    try {
      parseLangdockModelList(raw);
      expect.unreachable('expected a rejection');
    } catch (e) {
      const error = e as ProviderError;
      expect(error.category).toBe('INVALID_CONFIGURATION');
      expect(error.providerDetail).toContain('gpt-5-mini');
    }
  });

  it('refuses a model outside the allowlist, naming it', () => {
    try {
      parseLangdockModelList('gpt-5-mini,gpt-4o');
      expect.unreachable('expected a rejection');
    } catch (e) {
      const error = e as ProviderError;
      expect(error.category).toBe('INVALID_CONFIGURATION');
      expect(error.providerDetail).toContain("'gpt-4o'");
    }
  });

  it('refuses a duplicate rather than deduping it', () => {
    // Deduping would silently halve the rotation depth an operator thought
    // they had configured. A typo should be loud.
    try {
      parseLangdockModelList('gpt-5-mini,gpt-5.1,gpt-5-mini');
      expect.unreachable('expected a rejection');
    } catch (e) {
      const error = e as ProviderError;
      expect(error.category).toBe('INVALID_CONFIGURATION');
      expect(error.providerDetail).toContain('more than once');
    }
  });

  it('validates the allowlist before it looks for duplicates', () => {
    // Both are wrong here; the message must name the disallowed model, since
    // that is the one that would have cost money.
    try {
      parseLangdockModelList('gpt-4o,gpt-4o');
      expect.unreachable('expected a rejection');
    } catch (e) {
      expect((e as ProviderError).providerDetail).toContain("'gpt-4o'");
    }
  });
});

// ===========================================================================
// Construction
// ===========================================================================

describe('construction', () => {
  it('refuses an empty rotation list', () => {
    expect(() => new RotatingLangdockAdapter({ apiKey: KEY, models: [] })).toThrow(ProviderError);
  });

  it('refuses a list containing a forbidden model, before anything is billed', () => {
    expect(() => new RotatingLangdockAdapter({ apiKey: KEY, models: ['gpt-5-mini', 'gpt-4o'] }))
      .toThrow(ProviderError);
  });

  it('exposes the rotation order it was given', () => {
    expect([...rotating({ models: ['gpt-5.1', 'gpt-5-mini'] }).rotationOrder])
      .toEqual(['gpt-5.1', 'gpt-5-mini']);
  });

  it('presents itself as the same provider, so nothing downstream changes', () => {
    expect(rotating().providerName).toBe('langdock');
  });
});

// ===========================================================================
// Rotation
// ===========================================================================

describe('rotation', () => {
  it('does not rotate when the first model works', async () => {
    always(() => ok());
    const res = await rotating().generateCompletion(MESSAGES);
    expect(modelsTried()).toEqual(['gpt-5-mini']);
    expect(res.model).toBe('gpt-5-mini');
  });

  it('walks to the next model on 429 and reports which one answered', async () => {
    fetchMock.mockResolvedValueOnce(err(429, 'rate limited')).mockResolvedValueOnce(ok());
    const res = await rotating().generateCompletion(MESSAGES);
    expect(modelsTried()).toEqual(['gpt-5-mini', 'gpt-5.1']);
    expect(res.model).toBe('gpt-5.1');
  });

  it('walks the whole list in order when every model is rate limited', async () => {
    always(() => err(429, 'rate limited'));
    await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_429');
    expect(modelsTried()).toEqual(ALL);
  });

  it('rotates past a model the provider says is gone', async () => {
    fetchMock.mockResolvedValueOnce(modelGone()).mockResolvedValueOnce(ok());
    const res = await rotating().generateCompletion(MESSAGES);
    expect(modelsTried()).toEqual(['gpt-5-mini', 'gpt-5.1']);
    expect(res.model).toBe('gpt-5.1');
  });

  it.each([
    [401, 'HTTP_401'],
    [403, 'HTTP_403'],
    [500, 'HTTP_5XX'],
    [422, 'HTTP_422'],
  ] as const)('stops immediately on %i, trying exactly one model', async (status, category) => {
    // The paired half of the 429 test above: same adapter, same fixture, one
    // attempt instead of four. Without this, "rotates on 429" would also pass
    // against an adapter that rotates on everything.
    always(() => err(status));
    const error = await expectRejection(rotating().generateCompletion(MESSAGES), category);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.httpStatus).toBe(status);
  });

  it('stops immediately on a 400 that is about our request, not the model', async () => {
    always(() => err(400, 'messages must be a non-empty array', 'invalid_request_error'));
    await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets a non-rotatable error through unchanged, detail and all', async () => {
    // The contract with the worker: whatever finally escapes carries the same
    // category, status and detail it would have carried without rotation.
    always(() => err(403, 'account suspended', 'auth_error'));
    const error = await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_403');
    expect(error.providerDetail).toBe('auth_error: account suspended');
  });

  it('mixes reasons correctly: rotates on 429, then stops on the 403 behind it', async () => {
    fetchMock
      .mockResolvedValueOnce(err(429, 'rate limited'))
      .mockResolvedValueOnce(err(403, 'account suspended'));
    await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_403');
    expect(modelsTried()).toEqual(['gpt-5-mini', 'gpt-5.1']);
  });

  it('honours an explicit per-call model without rotating away from it', async () => {
    // An explicit model is an instruction, not a preference. Rotating past it
    // would silently spend a model the caller did not ask for.
    always(() => err(429, 'rate limited'));
    await expectRejection(rotating().generateCompletion(MESSAGES, { model: 'gpt-5.2' }), 'HTTP_429');
    expect(modelsTried()).toEqual(['gpt-5.2']);
  });

  it('still enforces the allowlist on an explicit per-call model', async () => {
    await expectRejection(
      rotating().generateCompletion(MESSAGES, { model: 'gpt-4o' }),
      'INVALID_CONFIGURATION'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes exactly one attempt when the list holds one model', async () => {
    always(() => err(429, 'rate limited'));
    await expectRejection(
      rotating({ models: ['gpt-5.1'] }).generateCompletion(MESSAGES),
      'HTTP_429'
    );
    expect(modelsTried()).toEqual(['gpt-5.1']);
  });
});

// ===========================================================================
// Exhaustion
// ===========================================================================

describe('exhaustion', () => {
  it('preserves the category and status, so the worker still calls it transient', async () => {
    always(() => err(429, 'rate limited'));
    const error = await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_429');
    expect(error.httpStatus).toBe(429);
    expect(error.provider).toBe('langdock');
  });

  it('says that every model was tried, and in what order', async () => {
    // Without this the dead-letter record is indistinguishable from a single
    // model being rate limited once.
    always(() => err(429, 'rate limited'));
    const error = await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_429');
    expect(error.providerDetail).toContain('all 4 model(s) exhausted');
    expect(error.providerDetail).toContain(ALL.join(' -> '));
    expect(error.providerDetail).toContain('rate limited');
  });

  it('falls back to the category when the last error carried no detail', async () => {
    always(() => new Response('', { status: 429 }));
    const error = await expectRejection(rotating().generateCompletion(MESSAGES), 'HTTP_429');
    expect(error.providerDetail).toContain('last: HTTP_429');
  });

  it('reports exhaustion even for a one-model list', async () => {
    always(() => err(429, 'rate limited'));
    const error = await expectRejection(
      rotating({ models: ['gpt-5.1'] }).generateCompletion(MESSAGES),
      'HTTP_429'
    );
    expect(error.providerDetail).toContain('all 1 model(s) exhausted');
  });
});

// ===========================================================================
// The abort budget
// ===========================================================================

describe('the shared abort budget', () => {
  it('does not start another attempt once the signal has aborted', async () => {
    // Rotation shares the orchestrator's 25-second budget across all attempts
    // rather than granting each one its own (ADR-006, consequence 3). Starting
    // a fourth attempt on a spent budget is how worst-case latency becomes
    // 4x25s.
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(err(429, 'rate limited'));
    });

    const error = await expectRejection(
      rotating().generateCompletion(MESSAGES, { signal: controller.signal }),
      'HTTP_429'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.providerDetail).toContain('aborted while rotating');
  });

  it('still tries the first model on an already-aborted signal', async () => {
    // The guard is `index > 0` on purpose: attempt zero runs and fetch itself
    // rejects with AbortError, which surfaces as TIMEOUT. Skipping it here
    // would produce a rejection with no attempt behind it and no category the
    // worker recognises.
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);

    await expectRejection(
      rotating().generateCompletion(MESSAGES, { signal: controller.signal }),
      'TIMEOUT'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// The observability hook
// ===========================================================================

describe('onRotate', () => {
  it('fires once per rotation with both models and the reason', async () => {
    const events: ModelRotationEvent[] = [];
    fetchMock
      .mockResolvedValueOnce(err(429, 'rate limited'))
      .mockResolvedValueOnce(modelGone())
      .mockResolvedValueOnce(ok());

    await rotating({ onRotate: (e) => events.push(e) }).generateCompletion(MESSAGES);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      from: 'gpt-5-mini',
      to: 'gpt-5.1',
      category: 'HTTP_429',
      attempt: 1,
      total: 4,
    });
    expect(events[0].detail).toBe('rate limited');
    expect(events[1]).toMatchObject({ from: 'gpt-5.1', to: 'gpt-5.2', category: 'HTTP_400', attempt: 2 });
  });

  it('never fires on the successful attempt', async () => {
    const events: ModelRotationEvent[] = [];
    always(() => ok());
    await rotating({ onRotate: (e) => events.push(e) }).generateCompletion(MESSAGES);
    expect(events).toHaveLength(0);
  });

  it('does not fire for the last model, which is exhaustion rather than rotation', async () => {
    const events: ModelRotationEvent[] = [];
    always(() => err(429, 'rate limited'));
    await expectRejection(
      rotating({ onRotate: (e) => events.push(e) }).generateCompletion(MESSAGES),
      'HTTP_429'
    );
    expect(events).toHaveLength(ALL.length - 1);
    expect(events.at(-1)).toMatchObject({ from: 'gpt-5.2', to: 'gpt-5', attempt: 3 });
  });

  it('omits detail entirely rather than sending undefined', async () => {
    const events: ModelRotationEvent[] = [];
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(ok());
    await rotating({ onRotate: (e) => events.push(e) }).generateCompletion(MESSAGES);
    expect('detail' in events[0]).toBe(false);
  });

  it('rotates fine without a hook', async () => {
    fetchMock.mockResolvedValueOnce(err(429, 'rate limited')).mockResolvedValueOnce(ok());
    await expect(rotating().generateCompletion(MESSAGES)).resolves.toMatchObject({ model: 'gpt-5.1' });
  });
});

// ===========================================================================
// What the meter sees
// ===========================================================================

describe('metrics during rotation', () => {
  it('records every attempt, not only the last', async () => {
    // Each attempt is a real request against a real quota. A rotation that
    // recorded once would under-report consumption to whoever is watching
    // whether the provider is healthy.
    fetchMock
      .mockResolvedValueOnce(err(429, 'rate limited'))
      .mockResolvedValueOnce(err(429, 'rate limited'))
      .mockResolvedValueOnce(ok());

    await rotating().generateCompletion(MESSAGES);

    const recorded = metricsCollector.getRecentMetrics();
    expect(recorded).toHaveLength(3);
    expect(recorded.map((m) => m.model)).toEqual(['gpt-5-mini', 'gpt-5.1', 'gpt-5.2']);
    expect(recorded.map((m) => m.success)).toEqual([false, false, true]);
  });
});
