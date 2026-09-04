/**
 * @file retained-adapters.test.ts
 * @description One conformance suite over the four adapters TuGPT keeps but
 * does not call.
 *
 * WHY A SHARED SUITE RATHER THAN FOUR FILES
 *
 * `index.ts` makes a specific promise about `anymize`, `logicc`, `mastra` and
 * `openai`: they are retained "so that reintroducing a provider later is a
 * wiring change rather than a rewrite". That promise is not about any one
 * adapter's features — it is about all four satisfying the same contract, so
 * that `DraftOrchestrator`, the fallback matrix and the worker's
 * transient/terminal classifier keep working when one is passed as a
 * `fallback`. A promise about a set is tested as a set: four separate files
 * would let one adapter drift while its own file stayed green.
 *
 * WHAT THIS FOUND
 *
 * Two of the four did not satisfy it. `MastraAdapter` and `OpenAIAdapter`
 * threw a bare `Error` with the **raw response body** interpolated into the
 * message, and dropped `options.signal` entirely. Wired in as a fallback that
 * would have meant:
 *
 *   - an error with no `category`, so the worker's transient/terminal
 *     classification had nothing to read;
 *   - a provider's echo of our prompt — or a customer's message — landing in
 *     a dead-letter record, which is the exact leak `extractProviderDetail`
 *     and `sanitizeProviderDetail` exist to prevent;
 *   - the orchestrator's 25-second budget not applying, so a hung request
 *     held a worker slot indefinitely.
 *
 * Both were brought into the contract in the same change. The comments in
 * those files record what they used to do, because "why is this written this
 * way" is the question a future reader will actually have.
 *
 * ANYMIZE IS NEVER CALLED HERE. Every test in this file runs against a stubbed
 * `fetch`; no request leaves the process. The 2026-08-18 isolation decision
 * (Anymize is in active use on unrelated projects and must not be called from
 * TuGPT under any configuration) is about real traffic, and
 * `apps/worker/tests/production-never-imports-cut-providers.test.ts` is what
 * enforces it in production wiring. The assertion below that Anymize's default
 * URL is what it is exists precisely so that a stubbed call is provably not a
 * real one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage } from './adapter';
import { AnymizeAdapter } from './anymize';
import { LogiccAdapter } from './logicc';
import { MastraAdapter } from './mastra';
import { OpenAIAdapter } from './openai';
import { ProviderError } from './errors';

const KEY = 'retained-test-key';
const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: 'Buenos días' }];

let fetchMock: ReturnType<typeof vi.fn>;

function res(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function always(factory: () => Response): void {
  // A fresh Response per call: a body can be read only once, and a shared
  // instance turns the second read into an artifact rather than a test.
  fetchMock.mockImplementation(() => Promise.resolve(factory()));
}

/**
 * Each retained adapter, with the minimum config it needs and a success body
 * in its own response shape. `expectedText` is what a correct adapter must
 * pull out of that body.
 */
const RETAINED: ReadonlyArray<{
  name: string;
  make: () => AIProviderAdapter;
  success: () => unknown;
  expectedText: string;
}> = [
  {
    name: 'anymize',
    make: () => new AnymizeAdapter({ apiKey: KEY, defaultModel: 'anymize-model' }),
    success: () => ({
      id: 'a-1',
      choices: [{ message: { content: 'hola' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    expectedText: 'hola',
  },
  {
    name: 'logicc',
    make: () => new LogiccAdapter({ apiKey: KEY, endpointUrl: 'https://logicc.invalid/v1' }),
    success: () => ({
      id: 'l-1',
      choices: [{ message: { content: 'hola' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    expectedText: 'hola',
  },
  {
    name: 'mastra',
    make: () => new MastraAdapter({ apiKey: KEY }),
    success: () => ({ id: 'm-1', text: 'hola', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }),
    expectedText: 'hola',
  },
  {
    name: 'openai',
    make: () => new OpenAIAdapter({ apiKey: KEY }),
    success: () => ({
      id: 'o-1',
      choices: [{ message: { content: 'hola' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    expectedText: 'hola',
  },
];

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

describe.each(RETAINED)('$name (retained, not wired)', ({ name, make, success, expectedText }) => {
  it('constructs without touching the network', () => {
    expect(() => make()).not.toThrow();
    // A constructor that called out would make merely importing the package a
    // side effect, and would make the isolation decision unenforceable.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names itself', () => {
    expect(make().providerName).toBe(name);
  });

  it('returns a complete CompletionResponse on success', async () => {
    always(() => res(success()));
    const out = await make().generateCompletion(MESSAGES);

    expect(out.provider).toBe(name);
    expect(out.text).toBe(expectedText);
    expect(typeof out.id).toBe('string');
    expect(out.id.length).toBeGreaterThan(0);
    expect(typeof out.model).toBe('string');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it.each([
    [401, 'HTTP_401'],
    [429, 'HTTP_429'],
    [500, 'HTTP_5XX'],
  ] as const)('raises a ProviderError %i -> %s that the worker can classify', async (status, category) => {
    // The whole point of the contract. An error without a `category` is an
    // error the worker cannot decide to retry or archive.
    always(() => res({ error: { message: 'nope' } }, status));
    try {
      await make().generateCompletion(MESSAGES);
      expect.unreachable(`${name} should have thrown`);
    } catch (e) {
      expect(e, `${name} threw ${(e as Error).name}`).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.category).toBe(category);
      expect(err.httpStatus).toBe(status);
      expect(err.provider).toBe(name);
    }
  });

  it('never puts a raw response body into the error', async () => {
    // The leak this suite was written for. A provider that echoes the request
    // must not be able to walk our prompt, or a customer's words, into a
    // dead-letter record.
    const secret = 'SYSTEM PROMPT: you are a receptionist for Clinica La Voz';
    always(() => res(`{"error":{"message":"rejected"},"echo":${JSON.stringify(secret)}}`, 400));
    try {
      await make().generateCompletion(MESSAGES);
      expect.unreachable(`${name} should have thrown`);
    } catch (e) {
      const err = e as ProviderError;
      expect(err.message).not.toContain(secret);
      expect(err.providerDetail ?? '').not.toContain(secret);
    }
  });

  it('raises NETWORK_FAILURE rather than leaking a transport error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    try {
      await make().generateCompletion(MESSAGES);
      expect.unreachable(`${name} should have thrown`);
    } catch (e) {
      expect(e, `${name} threw ${(e as Error).name}`).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).category).toBe('NETWORK_FAILURE');
    }
  });

  it('raises TIMEOUT on abort', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    try {
      await make().generateCompletion(MESSAGES);
      expect.unreachable(`${name} should have thrown`);
    } catch (e) {
      expect((e as ProviderError).category).toBe('TIMEOUT');
    }
  });

  it('passes the caller AbortSignal to fetch, so the latency budget applies', async () => {
    // adapter.ts documents this. Two of these four silently dropped it, which
    // meant the orchestrator's 25-second budget did not reach them.
    always(() => res(success()));
    const controller = new AbortController();
    await make().generateCompletion(MESSAGES, { signal: controller.signal });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('records exactly one provider call per attempt', async () => {
    always(() => res(success()));
    await make().generateCompletion(MESSAGES);
    const recorded = metricsCollector.getRecentMetrics();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: name, success: true });
  });
});

describe('the isolation decision', () => {
  it('anymize still points at its own service and nothing else', async () => {
    // Not a behaviour claim — a provenance one. Every request in this file is
    // stubbed, and this assertion is what makes "the stub stood in for a real
    // Anymize call" checkable rather than assumed. The enforcement that
    // matters lives in the worker's import guard.
    always(() => res({ id: 'a', choices: [{ message: { content: 'x' } }] }));
    await new AnymizeAdapter({ apiKey: KEY, defaultModel: 'm' }).generateCompletion(MESSAGES);
    expect(fetchMock.mock.calls[0][0]).toBe('https://app.anymize.ai/api/v1/llm/chat/completions');
  });

  it('anymize refuses to call anything without an explicit model', async () => {
    // It invents no default on purpose. A guessed model identifier is a
    // request to a service TuGPT has decided not to use.
    try {
      await new AnymizeAdapter({ apiKey: KEY }).generateCompletion(MESSAGES);
      expect.unreachable('expected a rejection');
    } catch (e) {
      expect((e as ProviderError).category).toBe('INVALID_CONFIGURATION');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
