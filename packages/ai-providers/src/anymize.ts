/**
 * @file anymize.ts
 * @description Anymize AI provider adapter — tertiary fallback provider.
 *
 * Implements the same AIProviderAdapter contract as LogicC and Langdock.
 * Anymize uses an OpenAI-compatible chat completions API.
 *
 * Content privacy: source message text, prompts, provider response body,
 * phone identifiers, authorization headers, and provider credentials are
 * NEVER logged. Only sanitized metadata is logged: provider name, model,
 * normalized error category, latency, token usage.
 */

import type {
  AIProviderAdapter,
  ChatMessage,
  CompletionOptions,
  CompletionResponse,
} from './adapter.js';
import { ProviderError } from './errors.js';

export interface AnymizeConfig {
  apiKey: string;
  endpointUrl: string;
  defaultModel: string;
}

export class AnymizeAdapter implements AIProviderAdapter {
  readonly providerName = 'anymize';

  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly defaultModel: string;

  constructor(config: AnymizeConfig) {
    if (!config.apiKey) {
      throw new ProviderError('anymize', 'INVALID_CONFIGURATION');
    }
    if (!config.endpointUrl) {
      throw new ProviderError('anymize', 'INVALID_CONFIGURATION');
    }
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl.replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResponse> {
    const model = options?.model || this.defaultModel;
    const startTime = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options?.maxTokens,
          temperature: options?.temperature,
        }),
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (err instanceof TypeError) {
        throw new ProviderError('anymize', 'NETWORK_FAILURE');
      }
      throw new ProviderError('anymize', 'NETWORK_FAILURE');
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const status = response.status;
      let errorBody: string;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = '';
      }

      // Map HTTP status to ProviderError categories
      if (status === 400) {
        throw new ProviderError('anymize', 'HTTP_400', 400);
      }
      if (status === 401) {
        throw new ProviderError('anymize', 'HTTP_401', 401);
      }
      if (status === 403) {
        throw new ProviderError('anymize', 'HTTP_403', 403);
      }
      if (status === 404) {
        throw new ProviderError('anymize', 'HTTP_404', 404);
      }
      if (status === 408) {
        throw new ProviderError('anymize', 'HTTP_408', 408);
      }
      if (status === 422) {
        throw new ProviderError('anymize', 'HTTP_422', 422);
      }
      if (status === 429) {
        throw new ProviderError('anymize', 'HTTP_429', 429);
      }
      if (status >= 500) {
        throw new ProviderError('anymize', 'HTTP_5XX', status);
      }
      throw new ProviderError('anymize', 'UNKNOWN_FAILURE', status);
    }

    let data: {
      id?: string;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    try {
      data = await response.json();
    } catch {
      throw new ProviderError('anymize', 'MALFORMED_PROVIDER_RESPONSE');
    }

    const text = data.choices?.[0]?.message?.content ?? '';

    // Empty output validation
    if (!text || text.trim().length === 0) {
      throw new ProviderError('anymize', 'EMPTY_OUTPUT');
    }

    // Oversized output validation
    const maxLen = options?.maxTokens ? options.maxTokens * 4 : 8000;
    if (text.length > maxLen) {
      throw new ProviderError('anymize', 'OUTPUT_TOO_LONG');
    }

    return {
      id: data.id || 'anymize-response',
      provider: 'anymize',
      model,
      text,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      latencyMs,
    };
  }
}