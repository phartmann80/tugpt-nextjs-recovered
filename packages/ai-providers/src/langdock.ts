import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError } from './errors';

/**
 * Langdock's auto model-routing identifier. As of the 2026-08-18
 * single-provider decision (see ADR-006), TuGPT does not pin individual
 * models — Langdock's `auto` mode selects the model per-request. This is
 * the single, centralized source of that default: do not hardcode a model
 * literal anywhere else. Callers that omit both `LangdockConfig.defaultModel`
 * and `CompletionOptions.model` get this value.
 */
export const LANGDOCK_AUTO_MODEL = 'auto';

export interface LangdockConfig {
  apiKey: string;
  endpointUrl?: string;
  /**
   * Overrides the model sent to Langdock. Defaults to LANGDOCK_AUTO_MODEL
   * ('auto'). Only set this for a deliberate, reviewed exception — the
   * standing policy is auto routing, not a pinned model.
   */
  defaultModel?: string;
}

export class LangdockAdapter implements AIProviderAdapter {
  readonly providerName = 'langdock';
  private apiKey: string;
  private endpointUrl: string;
  private defaultModel: string;

  constructor(config: LangdockConfig) {
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl || 'https://api.langdock.com/openai/eu/v1';
    this.defaultModel = config.defaultModel || LANGDOCK_AUTO_MODEL;
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = options.model || this.defaultModel;
    const signal = options.signal;

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
        throw ProviderError.fromHttpStatus(this.providerName, response.status);
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