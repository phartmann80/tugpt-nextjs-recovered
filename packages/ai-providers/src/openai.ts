import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError, extractProviderDetail } from './errors';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIAdapter implements AIProviderAdapter {
  readonly providerName = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.defaultModel = config.defaultModel || 'gpt-4o';
  }

  async generateCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = options.model || this.defaultModel;
    // adapter.ts states that an aborted signal cancels the request and yields
    // TIMEOUT. This adapter previously dropped the signal, so the
    // orchestrator's 25-second budget did not apply to it at all and a hung
    // request would have held a worker slot indefinitely.
    const signal = options.signal;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 1024,
        }),
        ...(signal ? { signal } : {}),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        // Only the provider's structured error fields, sanitized and
        // truncated -- never the raw body. This adapter used to throw
        // `new Error(\`OpenAI API Error (${response.status}): ${errorText}\`)`
        // with the whole body interpolated, which would have carried our
        // prompt (or a customer's message, when a provider echoes the
        // request) into the dead-letter record the moment it was wired in.
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
        id: data.id || `openai-${Date.now()}`,
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

      // Already classified by the HTTP branch above.
      if (err instanceof ProviderError) throw err;

      const category = err instanceof Error && err.name === 'AbortError'
        ? 'TIMEOUT'
        : 'NETWORK_FAILURE';

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs,
        success: false,
        errorCode: category,
      });
      // Previously this recorded `(err as Error).name` and re-threw the raw
      // error, so a transport failure escaped as a TypeError with no category
      // for the worker's transient/terminal classifier to read.
      throw new ProviderError(this.providerName, category);
    }
  }
}
