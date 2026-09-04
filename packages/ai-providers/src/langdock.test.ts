/**
 * @file langdock.test.ts
 * @description Tests for the only provider TuGPT actually calls.
 *
 * WHAT IS BEING DEFENDED
 *
 * 1. THE COST ALLOWLIST. TuGPT replaced a provider that was cut for being too
 *    expensive (ADR-006). `LANGDOCK_ALLOWED_MODELS` is a hard cost control,
 *    and it is checked twice on purpose — once in the constructor so a
 *    misconfigured deployment dies at boot, and once per call so a
 *    caller-supplied `options.model` cannot route around it. Both checks are
 *    tested separately: a test that only covers the constructor would pass
 *    against an adapter that lets any per-call override through, which is the
 *    exact hole the second check exists to close.
 *
 * 2. THE TERMINAL CLASSIFICATION. A rejected model raises
 *    INVALID_CONFIGURATION, which the worker treats as terminal — so the job
 *    archives immediately with the reason recorded instead of burning four
 *    retries to be told the same thing. If that category ever drifted to
 *    something transient, nothing would look broken; the bill would just grow.
 *
 * 3. NOT MASKING THE REAL ERROR. On a non-OK response the adapter reads the
 *    body to extract a diagnostic. If that read throws, the HTTP error must
 *    still surface — a 429 that turns into a body-parsing error is a
 *    retryable failure reclassified as a mystery.
 *
 * ON ASSERTING PROVIDER DETAIL RATHER THAN MESSAGE: `ProviderError.message`
 * is the category string by design (errors.ts), so `.toThrow(/sentence/)`
 * silently matches the category and never the sentence. Everything here
 * asserts on `category` and `providerDetail`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metricsCollector } from '@tugpt/observability';
import {
  LangdockAdapter,
  LANGDOCK_ALLOWED_MODELS,
  LANGDOCK_DEFAULT_MODEL,
  assertAllowedLangdockModel,
  isAllowedLangdockModel,
} from './langdock';
import { ProviderError } from './errors';

const KEY = 'langdock-test-key';
const MESSAGES = [{ role: 'user' as const, content: 'Buenos días' }];

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEFAULT_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

/**
 * `usage` is read with `'usage' in opts` rather than a default parameter,
 * because a default would swallow an explicit `usage: undefined` and hand the
 * adapter the default object instead — which is exactly what happened when
 * this file was written, turning the "provider omits usage entirely" test
 * into a second copy of the happy path.
 */
function completion(
  opts: { id?: string; content?: string | null; usage?: unknown } = {}
) {
  const { id = 'cmpl-1', content = 'Buenos días, ¿en qué puedo ayudarle?' } = opts;
  const usage = 'usage' in opts ? opts.usage : DEFAULT_USAGE;
  return { id, choices: [{ message: { content } }], usage };
}

async function expectRejection(
  promise: Promise<unknown>,
  category: string,
  detail?: RegExp
): Promise<ProviderError> {
  try {
    await promise;
    expect.unreachable(`expected a ${category} rejection`);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    const err = e as ProviderError;
    expect(err.category).toBe(category);
    if (detail) expect(err.providerDetail ?? '').toMatch(detail);
    return err;
  }
  throw new Error('unreachable');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // The collector logs a JSON line per call; keep the suite output readable
  // while still asserting on what it recorded.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  metricsCollector.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  metricsCollector.clear();
});

// ===========================================================================
// The allowlist
// ===========================================================================

describe('the model allowlist', () => {
  it('is exactly the four cost-approved models, cheapest first', () => {
    // Pinned as a literal rather than derived. This list is a spending
    // decision made by a person (ADR-006); widening it should require editing
    // a test that says so, not just editing the array.
    expect([...LANGDOCK_ALLOWED_MODELS]).toEqual(['gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5']);
    expect(LANGDOCK_DEFAULT_MODEL).toBe('gpt-5-mini');
  });

  it('defaults to the cheapest model on the list', () => {
    expect(LANGDOCK_ALLOWED_MODELS[0]).toBe(LANGDOCK_DEFAULT_MODEL);
  });

  it('accepts every allowed model and nothing else', () => {
    for (const model of LANGDOCK_ALLOWED_MODELS) {
      expect(isAllowedLangdockModel(model), model).toBe(true);
    }
    for (const model of ['auto', 'gpt-4o', 'gpt-5-nano', 'GPT-5-MINI', 'gpt-5 ', '', 'claude-3']) {
      expect(isAllowedLangdockModel(model), JSON.stringify(model)).toBe(false);
    }
  });

  it("refuses 'auto', which is what this replaced", () => {
    // LANGDOCK_AUTO_MODEL = 'auto' was real and Langdock answers it with a
    // 400. Reintroducing it is the specific regression ADR-006 names.
    expect(isAllowedLangdockModel('auto')).toBe(false);
  });

  it('raises a terminal INVALID_CONFIGURATION naming the model and the alternatives', () => {
    try {
      assertAllowedLangdockModel('gpt-4o');
      expect.unreachable('expected a rejection');
    } catch (e) {
      const err = e as ProviderError;
      expect(err.category).toBe('INVALID_CONFIGURATION');
      expect(err.httpStatus).toBeUndefined();
      expect(err.providerDetail).toContain("'gpt-4o'");
      // The person reading the dead-letter record needs to know what they may
      // use, not only that they used something wrong.
      expect(err.providerDetail).toContain('gpt-5-mini');
    }
  });

  it('lets an allowed model through without throwing', () => {
    expect(() => assertAllowedLangdockModel('gpt-5.2')).not.toThrow();
  });
});

// ===========================================================================
// Construction
// ===========================================================================

describe('construction', () => {
  it('rejects a forbidden default model before any request is billed', () => {
    expect(() => new LangdockAdapter({ apiKey: KEY, defaultModel: 'gpt-4o' })).toThrow(ProviderError);
  });

  it('accepts an allowed default model', () => {
    expect(() => new LangdockAdapter({ apiKey: KEY, defaultModel: 'gpt-5.1' })).not.toThrow();
  });

  it('names itself langdock', () => {
    expect(new LangdockAdapter({ apiKey: KEY }).providerName).toBe('langdock');
  });

  it('defaults to the EU endpoint', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.langdock.com/openai/eu/v1/chat/completions');
  });

  it('honours an endpoint override', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY, endpointUrl: 'https://proxy.internal/v1' })
      .generateCompletion(MESSAGES);
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.internal/v1/chat/completions');
  });
});

// ===========================================================================
// The request
// ===========================================================================

describe('the request', () => {
  it('sends a bearer token and the default model', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(LANGDOCK_DEFAULT_MODEL);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
  });

  it('honours temperature and maxTokens overrides, including zero', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES, {
      temperature: 0,
      maxTokens: 64,
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // `?? 0.7` rather than `|| 0.7`: temperature 0 is a legitimate request for
    // determinism, and `||` would silently replace it with 0.7.
    expect(body.temperature).toBe(0);
    expect(body.maxTokens).toBeUndefined();
    expect(body.max_tokens).toBe(64);
  });

  it('passes the caller AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    const controller = new AbortController();
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES, { signal: controller.signal });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('omits signal entirely when none is given', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect('signal' in (fetchMock.mock.calls[0][1] as object)).toBe(false);
  });

  it('refuses a per-call model outside the allowlist WITHOUT calling the provider', async () => {
    // The check that matters most. A per-call override is the one path that
    // could route around a cost control validated only at construction, and
    // "did not spend money" is the assertion, not "threw".
    const adapter = new LangdockAdapter({ apiKey: KEY });
    await expectRejection(
      adapter.generateCompletion(MESSAGES, { model: 'gpt-4o' }),
      'INVALID_CONFIGURATION',
      /gpt-4o/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an allowed per-call override', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES, { model: 'gpt-5.2' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe('gpt-5.2');
  });
});

// ===========================================================================
// The success path
// ===========================================================================

describe('a successful completion', () => {
  it('returns the text, the model actually used, and the usage', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    const res = await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);

    expect(res.id).toBe('cmpl-1');
    expect(res.provider).toBe('langdock');
    expect(res.model).toBe(LANGDOCK_DEFAULT_MODEL);
    expect(res.text).toBe('Buenos días, ¿en qué puedo ayudarle?');
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('derives totalTokens when the provider omits it', async () => {
    // Not cosmetic since 20260903000002: token counts are what the cost meter
    // prices. A silent zero here is a call that looks free.
    fetchMock.mockResolvedValue(
      json(completion({ usage: { prompt_tokens: 30, completion_tokens: 12 } }))
    );
    const res = await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect(res.usage.totalTokens).toBe(42);
  });

  it('reports zeros rather than NaN when usage is missing entirely', async () => {
    fetchMock.mockResolvedValue(json(completion({ usage: undefined })));
    const res = await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('returns an empty string, not undefined, when a choice has no content', async () => {
    fetchMock.mockResolvedValue(json({ id: 'cmpl-2', choices: [] }));
    const res = await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect(res.text).toBe('');
  });

  it('synthesises an id when the provider omits one', async () => {
    fetchMock.mockResolvedValue(json(completion({ id: '' })));
    const res = await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
    expect(res.id).toMatch(/^langdock-\d+$/);
  });

  it('records a successful provider call with the tokens the meter prices', async () => {
    fetchMock.mockResolvedValue(json(completion()));
    await new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);

    const recorded = metricsCollector.getRecentMetrics();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: 'langdock',
      model: LANGDOCK_DEFAULT_MODEL,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      success: true,
    });
    expect(recorded[0].errorCode).toBeUndefined();
  });
});

// ===========================================================================
// Failures
// ===========================================================================

describe('provider failures', () => {
  it.each([
    [400, 'HTTP_400'],
    [401, 'HTTP_401'],
    [403, 'HTTP_403'],
    [404, 'HTTP_404'],
    [408, 'HTTP_408'],
    [422, 'HTTP_422'],
    [429, 'HTTP_429'],
    [500, 'HTTP_5XX'],
    [503, 'HTTP_5XX'],
  ] as const)('maps HTTP %i to %s', async (status, category) => {
    fetchMock.mockResolvedValue(json({ error: { message: 'nope' } }, status));
    const err = await expectRejection(
      new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES),
      category
    );
    expect(err.httpStatus).toBe(status);
    expect(err.provider).toBe('langdock');
  });

  it('extracts what the provider objected to', async () => {
    // The reason providerDetail exists: this 400 was once diagnosable only by
    // curling the API by hand from the server.
    fetchMock.mockResolvedValue(
      json(
        { error: { message: 'Invalid model, available models are: gpt-5', type: 'invalid_request_error' } },
        400
      )
    );
    const err = await expectRejection(
      new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES),
      'HTTP_400'
    );
    expect(err.providerDetail).toBe(
      'invalid_request_error: Invalid model, available models are: gpt-5'
    );
  });

  it('never lets reading the body mask the HTTP error', async () => {
    // A response whose body read rejects. Without the inner try/catch the
    // caller would see a TypeError reclassified as NETWORK_FAILURE — a
    // retryable 429 turned into a mystery, or a terminal 403 turned into
    // something the worker retries.
    const broken = {
      ok: false,
      status: 429,
      text: () => Promise.reject(new Error('stream already consumed')),
    } as unknown as Response;
    fetchMock.mockResolvedValue(broken);

    const err = await expectRejection(
      new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES),
      'HTTP_429'
    );
    expect(err.providerDetail).toBeUndefined();
  });

  it('records a failed call with the HTTP error code', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'slow down' } }, 429));
    await expectRejection(new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES), 'HTTP_429');

    const recorded = metricsCollector.getRecentMetrics();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ success: false, errorCode: 'HTTP_429', totalTokens: 0 });
  });

  it('maps an AbortError to TIMEOUT', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);

    const err = await expectRejection(
      new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES),
      'TIMEOUT'
    );
    expect(err.httpStatus).toBeUndefined();
    expect(metricsCollector.getRecentMetrics()[0]).toMatchObject({ errorCode: 'TIMEOUT', success: false });
  });

  it('maps a transport failure to NETWORK_FAILURE', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expectRejection(new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES), 'NETWORK_FAILURE');
    expect(metricsCollector.getRecentMetrics()[0]).toMatchObject({
      errorCode: 'NETWORK_FAILURE',
      success: false,
    });
  });

  it('records exactly one metric per call, never two', async () => {
    // The HTTP branch records and then throws a ProviderError that the outer
    // catch re-raises. If that re-raise ever fell through to the network
    // branch, every failure would be double-counted — and the count is what
    // an operator reads to decide whether the provider is down.
    fetchMock.mockResolvedValue(json({ error: { message: 'nope' } }, 500));
    await expectRejection(new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES), 'HTTP_5XX');
    expect(metricsCollector.getRecentMetrics()).toHaveLength(1);
  });

  it('does not record a metric for a model refused before the request', async () => {
    // Nothing was called, so nothing was billed, so nothing belongs in the
    // provider-call series.
    await expectRejection(
      new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES, { model: 'gpt-4o' }),
      'INVALID_CONFIGURATION'
    );
    expect(metricsCollector.getRecentMetrics()).toHaveLength(0);
  });

  it('surfaces a malformed JSON body as NETWORK_FAILURE rather than hanging', async () => {
    fetchMock.mockResolvedValue(new Response('not json at all', { status: 200 }));
    await expectRejection(new LangdockAdapter({ apiKey: KEY }).generateCompletion(MESSAGES), 'NETWORK_FAILURE');
  });
});
