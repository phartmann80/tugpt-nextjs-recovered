import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError, extractProviderDetail } from './errors';

/**
 * Models TuGPT is permitted to send to Langdock.
 *
 * Langdock's OpenAI-compatible endpoint exposes considerably more models than
 * these. The rest are excluded on cost grounds by owner decision (2026-08-19):
 * TuGPT replaced a provider that was cut for being too expensive, so the
 * allowlist is a hard cost control, not a suggestion. Anything outside this
 * list is refused before a request is made — see `assertAllowedLangdockModel`.
 *
 * Order is meaningful: it is the intended rotation order for the follow-up
 * model-level rotation work (cheapest first).
 */
export const LANGDOCK_ALLOWED_MODELS = ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5'] as const;

export type LangdockModel = (typeof LANGDOCK_ALLOWED_MODELS)[number];

/**
 * Default model when `LANGDOCK_MODEL` is unset.
 *
 * Replaces the former `LANGDOCK_AUTO_MODEL = 'auto'`. Langdock's
 * OpenAI-compatible endpoint does NOT support an `auto` pseudo-model: sending
 * it returns HTTP 400 `invalid_request_error` with the list of real models.
 * Verified against the live API on 2026-08-19. Do not reintroduce 'auto' —
 * see ADR-006.
 */
export const LANGDOCK_DEFAULT_MODEL: LangdockModel = 'gpt-5-mini';

/** Type guard for the allowlist. */
export function isAllowedLangdockModel(model: string): model is LangdockModel {
  return (LANGDOCK_ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Throw a terminal configuration error unless `model` is on the allowlist.
 *
 * INVALID_CONFIGURATION is a terminal category, so a bad model never burns
 * retries: the job archives immediately with the reason recorded.
 *
 * @throws ProviderError INVALID_CONFIGURATION
 */
export function assertAllowedLangdockModel(model: string, provider = 'langdock'): asserts model is LangdockModel {
  if (!isAllowedLangdockModel(model)) {
    throw new ProviderError(
      provider,
      'INVALID_CONFIGURATION',
      undefined,
      `Model '${model}' is not on the TuGPT Langdock allowlist. Allowed: ${LANGDOCK_ALLOWED_MODELS.join(', ')}.`
    );
  }
}

export interface LangdockConfig {
  apiKey: string;
  endpointUrl?: string;
  /**
   * Model to send. Defaults to LANGDOCK_DEFAULT_MODEL ('gpt-5-mini').
   * Must be on LANGDOCK_ALLOWED_MODELS; anything else is rejected in the
   * constructor rather than at request time.
   */
  defaultModel?: string;
}

export class LangdockAdapter implements AIProviderAdapter {
  readonly providerName = 'langdock';
  private apiKey: string;
  private endpointUrl: string;
  private defaultModel: LangdockModel;

  /**
   * @throws ProviderError INVALID_CONFIGURATION if `defaultModel` is set to a
   * model outside the allowlist. Failing here means a misconfigured deployment
   * is caught at construction, before any request is billed.
   */
  constructor(config: LangdockConfig) {
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl || 'https://api.langdock.com/openai/eu/v1';

    const model = config.defaultModel || LANGDOCK_DEFAULT_MODEL;
    assertAllowedLangdockModel(model, 'langdock');
    this.defaultModel = model;
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = options.model || this.defaultModel;
    const signal = options.signal;

    // Re-check per call: a caller-supplied override must not be able to route
    // around the cost allowlist. Throws INVALID_CONFIGURATION (terminal).
    assertAllowedLangdockModel(model, this.providerName);

    const requestBody = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
    };

    try {
      const response = await fetch(`${this.endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        ...(signal ? { signal } : {}),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        // Capture what the provider actually objected to. Only its structured
        // error fields are extracted, then sanitized and truncated — never the
        // raw body. Reading the body must not mask the HTTP error itself, so
        // any failure here degrades to no detail rather than throwing.
        let detail: string | undefined;
        try {
          detail = extractProviderDetail(await response.text());
        } catch {
          detail = undefined;
        }

        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: `HTTP_${response.status}`,
        });
        throw ProviderError.fromHttpStatus(this.providerName, response.status, detail);
      }

      const data = (await response.json()) as {
        id: string;
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices[0]?.message?.content || '';
      const promptTokens = data.usage?.prompt_tokens || 0;
      const completionTokens = data.usage?.completion_tokens || 0;
      const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        success: true,
      });

      return {
        id: data.id || `langdock-${Date.now()}`,
        provider: this.providerName,
        model,
        text,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;

      // If it's already a ProviderError, re-throw as-is
      if (err instanceof ProviderError) {
        throw err;
      }

      // AbortError → TIMEOUT
      if (err instanceof Error && err.name === 'AbortError') {
        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: 'TIMEOUT',
        });
        throw new ProviderError(this.providerName, 'TIMEOUT');
      }

      // Network failure (TypeError: fetch failed)
      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs,
        success: false,
        errorCode: 'NETWORK_FAILURE',
      });
      throw new ProviderError(this.providerName, 'NETWORK_FAILURE');
    }
  }
}
