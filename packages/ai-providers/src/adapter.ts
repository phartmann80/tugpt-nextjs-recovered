/**
 * @file adapter.ts
 * @description Unified AI Provider Adapter Contract for TuGPT.
 *
 * STATUS: Provisional (see docs/adr/ADR-006-provider-adapter-architecture.md).
 * This interface currently exposes only `generateCompletion` and covers
 * synchronous chat completion alone. It intentionally does NOT yet define
 * streaming, structured output, tool calls, embeddings, image/video
 * generation, speech-to-text/text-to-speech, cancellation, retry policy, or
 * usage/cost reporting. Those capabilities require a dedicated
 * capability-based architecture review before this contract is expanded.
 *
 * Do not describe this contract as frozen or final. Any expansion should be
 * tracked against ADR-006 and requires that review, not an ad-hoc addition.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly organizationId?: string;
  readonly requestId?: string;
  /**
   * Optional AbortSignal for cancellation. When the signal aborts, the
   * underlying fetch() call is terminated and the adapter throws a
   * ProviderError with category 'TIMEOUT'. This is a real abort, not a
   * Promise.race() wrapper — the HTTP request is genuinely cancelled.
   */
  readonly signal?: AbortSignal;
}

export interface CompletionResponse {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly latencyMs: number;
}

export interface AIProviderAdapter {
  readonly providerName: string;
  
  /**
   * Generates a text completion based on standard ChatMessages.
   * The sole capability currently implemented (see ADR-006). Live production
   * calls to external providers remain disabled until Phase 3 authorization.
   *
   * When options.signal is provided and aborted, the underlying fetch() is
   * cancelled and a ProviderError with category 'TIMEOUT' is thrown.
   */
  generateCompletion(
    messages: readonly ChatMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResponse>;
}