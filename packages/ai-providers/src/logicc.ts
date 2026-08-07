import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError } from './errors';

export interface LogiccConfig {
  apiKey: string;
  endpointUrl: string;
  defaultModel?: string;
}

/**
 * Logicc AI provider adapter.
 *
 * Thin HTTP adapter implementing AIProviderAdapter, same pattern as
 * LangdockAdapter. POSTs to the Logicc chat completions endpoint and
 * returns a CompletionResponse. Throws structured ProviderError on
 * HTTP failures, network failures, and timeouts.
 */
export class LogiccAdapter implements AIProviderAdapter {
  readonly providerName = 'logicc';
  private apiKey: string;
  private endpointUrl: string;
  private defaultModel: string;

  constructor(config: LogiccConfig) {
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl;
    this.defaultModel = config.defaultModel || 'logicc-default';
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
        id: data.id || `logicc-${Date.now()}`,
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