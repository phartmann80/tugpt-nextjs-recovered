/**
 * @file langdock-adapter.test.ts
 * @description Tests for LangdockAdapter's auto model-routing default.
 *
 * Added 2026-08-18 alongside the single-provider (Langdock-only) decision
 * — see ADR-006. TuGPT does not pin individual models: the adapter must
 * default to Langdock's `auto` model-routing identifier whenever no
 * explicit model is supplied, and that default must live in exactly one
 * place (LANGDOCK_AUTO_MODEL in packages/ai-providers/src/langdock.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LangdockAdapter, LANGDOCK_AUTO_MODEL } from '@tugpt/ai-providers';

// Mock the metricsCollector so we don't need the real observability package
vi.mock('@tugpt/observability', () => ({
  metricsCollector: {
    recordProviderCall: vi.fn(),
  },
}));

function mockSuccessfulFetch(): ReturnType<typeof vi.fn> {
  const mockResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'resp-1',
      choices: [{ message: { content: 'Generated draft text.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };
  const fetchMock = vi.fn().mockResolvedValue(mockResponse);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LangdockAdapter — auto model routing default', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('LANGDOCK_AUTO_MODEL is "auto"', () => {
    expect(LANGDOCK_AUTO_MODEL).toBe('auto');
  });

  it('sends model "auto" when no defaultModel and no per-call model are given', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string);
    expect(body.model).toBe('auto');
    expect(body.model).toBe(LANGDOCK_AUTO_MODEL);
  });

  it('does not require a defaultModel in config to construct or call successfully', async () => {
    mockSuccessfulFetch();
    // No defaultModel passed — this must not throw, unlike AnymizeAdapter,
    // which requires an explicit model. Langdock's auto routing is the
    // point: no model needs to be supplied anywhere.
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    const result = await adapter.generateCompletion([{ role: 'user', content: 'Hello' }]);

    expect(result.provider).toBe('langdock');
    expect(result.model).toBe('auto');
  });

  it('an explicit per-call model still overrides auto (escape hatch preserved)', async () => {
    const fetchMock = mockSuccessfulFetch();
    const adapter = new LangdockAdapter({ apiKey: 'test-key' });

    await adapter.generateCompletion([{ role: 'user', content: 'Hello' }], { model: 'gpt-5.2' });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string);
    expect(body.model).toBe('gpt-5.2');
  });
});
