/**
 * @file orchestrator.ts
 * @description Draft orchestrator: calls providers in strict order with
 * automatic fallback on transient failures only.
 *
 * Per Paul's spec:
 * 1. Logicc = primary
 * 2. Langdock = secondary fallback
 * 3. Anymize = tertiary fallback
 *
 * No round-robin, random routing, or load balancing.
 * A provider may fall through to the next only for transient conditions.
 * If Anymize also fails with a transient error, return the normal
 * transient generation failure to the worker so the existing PGMQ
 * attempt lifecycle handles it.
 *
 * Provider fallback inside one delivery does not create additional
 * PGMQ delivery attempts.
 *
 * Content privacy: source message text, prompts, provider response body,
 * phone identifiers, authorization headers, and provider credentials are
 * NEVER logged. Only sanitized metadata is logged: provider name, model,
 * normalized error category, latency, token usage.
 */

import type { AIProviderAdapter, ChatMessage, CompletionOptions } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';
import { shouldFallback } from './fallback-matrix.js';
import type { DraftConfig, DraftOutcome, DraftRequest, DraftResult } from './types.js';

export class DraftOrchestrator {
  private readonly primary: AIProviderAdapter;
  private readonly fallback: AIProviderAdapter;
  private readonly tertiary: AIProviderAdapter | null;

  constructor(config: {
    primary: AIProviderAdapter;
    fallback: AIProviderAdapter;
    tertiary?: AIProviderAdapter;
  }) {
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.tertiary = config.tertiary ?? null;
  }

  async generateDraft(request: DraftRequest): Promise<DraftOutcome> {
    const messages = this.buildPrompt(request);
    const options: CompletionOptions = {
      maxTokens: request.config.maxDraftLength,
      temperature: 0.7,
    };

    // Try primary
    const primaryResult = await this.tryProvider(this.primary, messages, options);
    if (primaryResult.success) {
      return { success: true, result: primaryResult.result! };
    }

    // Check if fallback is allowed for this error category
    if (!shouldFallback(primaryResult.error!.category)) {
      return { success: false, error: primaryResult.error };
    }

    // Try secondary fallback
    const fallbackResult = await this.tryProvider(this.fallback, messages, options);
    if (fallbackResult.success) {
      return { success: true, result: fallbackResult.result! };
    }

    // Check if fallback is allowed for secondary error
    if (!shouldFallback(fallbackResult.error!.category)) {
      return { success: false, error: fallbackResult.error };
    }

    // Try tertiary fallback (Anymize)
    if (this.tertiary) {
      const tertiaryResult = await this.tryProvider(this.tertiary, messages, options);
      if (tertiaryResult.success) {
        return { success: true, result: tertiaryResult.result! };
      }

      // If Anymize also fails with a transient error, return the normal
      // transient generation failure to the worker so the existing PGMQ
      // attempt lifecycle handles it.
      return { success: false, error: tertiaryResult.error };
    }

    // No tertiary configured: return the secondary's error
    return { success: false, error: fallbackResult.error };
  }

  private async tryProvider(
    adapter: AIProviderAdapter,
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<{ success: true; result: DraftResult } | { success: false; error: { category: string; provider: string } }> {
    try {
      const response = await adapter.generateCompletion(messages, options);
      return {
        success: true,
        result: {
          text: response.text,
          provider: response.provider,
          model: response.model,
          latencyMs: response.latencyMs,
        },
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        return {
          success: false,
          error: {
            category: err.category,
            provider: err.providerName,
          },
        };
      }
      return {
        success: false,
        error: {
          category: 'UNKNOWN_FAILURE',
          provider: adapter.providerName,
        },
      };
    }
  }

  private buildPrompt(request: DraftRequest): ChatMessage[] {
    const { config, sourceMessageText } = request;

    const systemPrompt = `You are a helpful business assistant for a WhatsApp-based business.

Business instructions: ${config.businessInstructions}

Personality: ${config.personality}

Response rules: ${config.responseRules}

Tone: ${config.tone}

Always greet the customer. Keep the response under ${config.maxDraftLength} characters.`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sourceMessageText },
    ];
  }
}