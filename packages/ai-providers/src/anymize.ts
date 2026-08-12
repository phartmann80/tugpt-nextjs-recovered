import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError } from './errors';

export interface AnymizeConfig {
  apiKey: string;
  endpointUrl?: string;
  defaultModel?: string;
}

/**
 * Anymize AI provider adapter.
 *
 * Thin HTTP adapter implementing AIProviderAdapter, same pattern as
 * LogiccAdapter and LangdockAdapter. POSTs to the Anymize chat completions
 * endpoint and returns a CompletionResponse. Throws structured ProviderError on
 * HTTP failures, network failures, and timeouts.
 *
 * Default endpoint: https://app.anymize.ai/api/v1/llm (official Anymize API base).
 * The full request URL becomes: {endpointUrl}/chat/completions
 *
 * No default model is invented. ANYMIZE_DEFAULT_MODEL must be set to a valid
 * model identifier when Anymize is enabled. Use GET /models to discover
 * available models from the account.
 */
export class AnymizeAdapter implements AIProviderAdapter {
  readonly providerName = 'anymize';
  private apiKey: string;
  private endpointUrl: string;
  private defaultModel: string;

  constructor(config: AnymizeConfig) {
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl || 'https://app.anymize.ai/api/v1/llm';
    this.defaultModel = config.defaultModel || '';
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = options.model || this.defaultModel;
    const signal = options.signal;

    if (!model) {
      throw new ProviderError(this.providerName, 'INVALID_CONFIGURATION');
    }

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

      // Parse JSON body. If parsing fails on a 2xx response, classify as
      // MALFORMED_PROVIDER_RESPONSE (terminal), not NETWORK_FAILURE.
      let data: {
        id: string;
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      try {
        data = await response.json();
      } catch {
        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: 'MALFORMED_PROVIDER_RESPONSE',
        });
        throw new ProviderError(this.providerName, 'MALFORMED_PROVIDER_RESPONSE');
      }

      // Validate required response shape. Invalid shape on 2xx is terminal.
      if (
        !data ||
        !data.choices ||
        !Array.isArray(data.choices) ||
        data.choices.length === 0 ||
        !data.choices[0]?.message?.content
      ) {
        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: 'MALFORMED_PROVIDER_RESPONSE',
        });
        throw new ProviderError(this.providerName, 'MALFORMED_PROVIDER_RESPONSE');
      }

      const text = data.choices[0].message.content;
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
        id: data.id || `anymize-${Date.now()}`,
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

      if (err instanceof ProviderError) {
        throw err;
      }

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