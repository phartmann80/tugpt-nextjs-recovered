/**
 * @file orchestrator.ts
 * @description Draft generation orchestrator with primary/fallback provider routing.
 *
 * As of the 2026-08-18 single-provider decision (see ADR-006), production
 * wiring (apps/worker/src/draft-orchestrator-factory.ts) configures only a
 * `primary` provider (Langdock) — no `fallback` or `tertiary`. This class
 * still accepts them, kept intentionally so a fallback provider can be
 * reintroduced later without an interface change; they are simply unused
 * in the current configuration.
 *
 * Calls the primary provider with a 25-second AbortController timeout. If a
 * `fallback` is configured and the primary returns a fallback-eligible
 * error, calls the fallback with the same timeout; if a `tertiary` is also
 * configured and the fallback also returns a fallback-eligible error, calls
 * the tertiary. On a fallback-prohibited error, or when no further provider
 * is configured, returns the error immediately.
 *
 * In the current single-provider configuration, any primary failure —
 * transient or terminal — is returned as-is. There is no in-process
 * hand-off to a next provider. Transient categories are retried by the
 * caller (apps/worker/src/draft-worker.ts) via the PGMQ visibility-timeout
 * retry policy (5s, then 15s, then archive); terminal categories archive
 * immediately. See that file for the full retry/archive lifecycle.
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
  /** The sole configured provider in the current architecture (Langdock). */
  primary: AIProviderAdapter;
  /**
   * Optional secondary fallback provider. Not configured in production
   * today — see the file header. When omitted, any primary failure is
   * returned as-is; no hand-off is attempted.
   */
  fallback?: AIProviderAdapter;
  /** Optional tertiary fallback provider. Only meaningful when `fallback` is also set. */
  tertiary?: AIProviderAdapter;
}

export class DraftOrchestrator {
  private primary: AIProviderAdapter;
  private fallback: AIProviderAdapter | null;
  private tertiary: AIProviderAdapter | null;

  constructor(config: DraftOrchestratorConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback ?? null;
    this.tertiary = config.tertiary ?? null;
  }

  /**
   * Generate a draft from the given request.
   *
   * Returns a DraftGenerationResult: success with text/provider/model/latency,
   * or failure with a structured ProviderError.
   *
   * Current production configuration: single provider (Langdock), no
   * fallback/tertiary. If `fallback` is configured (not the case in
   * production today), the chain is primary -> fallback -> tertiary.
   * Any hand-off happens inside one queue delivery. The PGMQ retry
   * lifecycle (attempt 1 -> 5s, attempt 2 -> 15s, attempt 3 -> archive) is
   * preserved at the worker level, not here.
   */
  async generateDraft(request: DraftRequest): Promise<DraftGenerationResult> {
    const messages = buildPromptMessages(request.sourceMessageText, request.config);

    const options: CompletionOptions = {
      maxTokens: CONSERVATIVE_TOKEN_LIMIT,
      organizationId: request.organizationId,
      requestId: request.requestId,
    };

    // Attempt the configured provider with a 25s timeout.
    const primaryResult = await this.callProvider(this.primary, messages, options);

    if (primaryResult.success) {
      return this.validateOutput(primaryResult.response, request.config.maxDraftLength);
    }

    // Single-provider mode: no fallback configured. The primary's error —
    // transient or terminal — is final for this call. There is no next
    // provider to hand off to; the caller (draft-worker.ts) applies the
    // PGMQ retry/archive policy based on the error category.
    if (!this.fallback) {
      return { success: false, error: primaryResult.error };
    }

    // Check if fallback is allowed for this error category
    const fallbackDecision = shouldFallback(primaryResult.error.category);

    if (fallbackDecision === 'FALLBACK_PROHIBITED') {
      return { success: false, error: primaryResult.error };
    }

    // Attempt the configured secondary fallback provider with a 25s timeout.
    // (Not configured in production today — see the file header.)
    const fallbackResult = await this.callProvider(this.fallback, messages, options);

    if (fallbackResult.success) {
      return this.validateOutput(fallbackResult.response, request.config.maxDraftLength);
    }

    // Check if tertiary fallback is allowed for the secondary's error category
    const tertiaryDecision = shouldFallback(fallbackResult.error.category);

    if (tertiaryDecision === 'FALLBACK_PROHIBITED') {
      return { success: false, error: fallbackResult.error };
    }

    // If no tertiary provider configured, return the secondary error
    if (!this.tertiary) {
      return { success: false, error: fallbackResult.error };
    }

    // Attempt the configured tertiary fallback provider with a 25s timeout.
    // (Not configured in production today — see the file header.)
    const tertiaryResult = await this.callProvider(this.tertiary, messages, options);

    if (tertiaryResult.success) {
      return this.validateOutput(tertiaryResult.response, request.config.maxDraftLength);
    }

    // All configured providers failed: return the tertiary's error.
    return { success: false, error: tertiaryResult.error };
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
      providerReference: response.id,
      usage: response.usage,
    };

    return { success: true, result };
  }
}