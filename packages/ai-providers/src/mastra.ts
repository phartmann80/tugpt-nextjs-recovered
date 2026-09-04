import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError, extractProviderDetail } from './errors';

export interface MastraConfig {
  apiKey: string;
  gatewayUrl?: string;
  defaultAgent?: string;
}

export class MastraAdapter implements AIProviderAdapter {
  readonly providerName = 'mastra';
  private apiKey: string;
  private gatewayUrl: string;
  private defaultAgent: string;

  constructor(config: MastraConfig) {
    this.apiKey = config.apiKey;
    this.gatewayUrl = config.gatewayUrl || 'https://gateway-api.mastra.ai';
    this.defaultAgent = config.defaultAgent || 'default-assistant';
  }

  async generateCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const agentName = options.model || this.defaultAgent;
    // adapter.ts states that an aborted signal cancels the request and yields
    // TIMEOUT. This adapter previously dropped the signal, so the
    // orchestrator's 25-second budget did not apply to it at all and a hung
    // request would have held a worker slot indefinitely.
    const signal = options.signal;

    const requestBody = {
      agent: agentName,
      messages,
      context: {
        organizationId: options.organizationId,
        requestId: options.requestId,
      },
    };

    try {
      const response = await fetch(`${this.gatewayUrl}/v1/agents/${agentName}/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mastra-Api-Key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        ...(signal ? { signal } : {}),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        // Only the provider's structured error fields, sanitized and
        // truncated -- never the raw body. This adapter used to interpolate
        // the whole body into an Error message, which would have carried our
        // prompt (or a customer's message, when a gateway echoes the request)
        // into the dead-letter record the moment it was wired in.
        let detail: string | undefined;
        try {
          detail = extractProviderDetail(await response.text());
        } catch {
          detail = undefined;
        }

        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model: agentName,
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
        id?: string;
        text?: string;
        response?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      };

      const text = data.text || data.response || '';
      const promptTokens = data.usage?.promptTokens || 0;
      const completionTokens = data.usage?.completionTokens || 0;
      const totalTokens = data.usage?.totalTokens || promptTokens + completionTokens;

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model: agentName,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        success: true,
      });

      return {
        id: data.id || `mastra-${Date.now()}`,
        provider: this.providerName,
        model: agentName,
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
        model: agentName,
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
