/**
 * @file orchestrator.ts
 * @description Draft generation orchestrator with primary/fallback provider routing.
 *
 * Calls the primary provider (Logicc) with a 25-second AbortController timeout.
 * On a fallback-eligible error, calls the fallback provider (Langdock) with
 * the same 25-second timeout. On a fallback-prohibited error, returns the
 * error immediately without calling the fallback.
 *
 * Validates output: non-empty and within maxDraftLength (character limit).
 * A separate conservative provider-token limit is used for the maxTokens
 * option, distinct from the character-length output constraint.
 */

import type { AIProviderAdapter, ChatMessage, CompletionOptions } from '@tugpt/ai-providers';
import { ProviderError } from '@tugpt/ai-providers';
import { shouldFallback } from './fallback-matrix';
import { buildPromptMessages } from './prompt-builder';
import type { DraftRequest, DraftGenerationResult, DraftResult } from './types';

/** 25-second timeout for provider calls. */
const PROVIDER_TIMEOUT_MS = 25_000;

/**
 * Conservative token limit passed to the provider. This is NOT equivalent
 * to maxDraftLength (which is a character constraint on the final output).
 * It is a separate, conservative generation limit to prevent excessive
 * token usage while still allowing the provider to generate enough text.
 */
const CONSERVATIVE_TOKEN_LIMIT = 1024;

export interface DraftOrchestratorConfig {
  /** Primary provider adapter (Logicc). */
  primary: AIProviderAdapter;
  /** Fallback provider adapter (Langdock). */
  fallback: AIProviderAdapter;
}

export class DraftOrchestrator {
  private primary: AIProviderAdapter;
  private fallback: AIProviderAdapter;

  constructor(config: DraftOrchestratorConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
  }

  /**
   * Generate a draft from the given request.
   *
   * Returns a DraftGenerationResult: success with text/provider/model/latency,
   * or failure with a structured ProviderError.
   */
  async generateDraft(request: DraftRequest): Promise<DraftGenerationResult> {
    const messages = buildPromptMessages(request.sourceMessageText, request.config);

    const options: CompletionOptions = {
      maxTokens: CONSERVATIVE_TOKEN_LIMIT,
      organizationId: request.organizationId,
      requestId: request.requestId,
    };

    // Attempt primary provider with 25s timeout
    const primaryResult = await this.callProvider(this.primary, messages, options);

    if (primaryResult.success) {
      return this.validateOutput(primaryResult.response, request.config.maxDraftLength);
    }

    // Check if fallback is allowed for this error category
    const fallbackDecision = shouldFallback(primaryResult.error.category);

    if (fallbackDecision === 'FALLBACK_PROHIBITED') {
      return { success: false, error: primaryResult.error };
    }

    // Attempt fallback provider with 25s timeout
    const fallbackResult = await this.callProvider(this.fallback, messages, options);

    if (fallbackResult.success) {
      return this.validateOutput(fallbackResult.response, request.config.maxDraftLength);
    }

    // Both providers failed: return the fallback error
    return { success: false, error: fallbackResult.error };
  }

  /**
   * Call a provider with a 25-second AbortController timeout.
   * Returns either a successful CompletionResponse or a ProviderError.
   */
  private async callProvider(
    adapter: AIProviderAdapter,
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<{ success: true; response: import('@tugpt/ai-providers').CompletionResponse } | { success: false; error: ProviderError }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
      const response = await adapter.generateCompletion(messages, {
        ...options,
        signal: controller.signal,
      });
      return { success: true, response };
    } catch (err) {
      if (err instanceof ProviderError) {
        return { success: false, error: err };
      }

      // Unknown error: classify as UNKNOWN_FAILURE
      return {
        success: false,
        error: new ProviderError(adapter.providerName, 'UNKNOWN_FAILURE'),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate provider output: non-empty and within maxDraftLength.
   * maxDraftLength is a character-length constraint on the final draft text.
   */
  private validateOutput(
    response: import('@tugpt/ai-providers').CompletionResponse,
    maxDraftLength: number
  ): DraftGenerationResult {
    const text = response.text;

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: new ProviderError(response.provider, 'EMPTY_OUTPUT'),
      };
    }

    if (text.length > maxDraftLength) {
      return {
        success: false,
        error: new ProviderError(response.provider, 'OUTPUT_TOO_LONG'),
      };
    }

    const result: DraftResult = {
      text,
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
    };

    return { success: true, result };
  }
}