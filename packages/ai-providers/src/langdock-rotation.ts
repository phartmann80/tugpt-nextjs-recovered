/**
 * @file langdock-rotation.ts
 * @description Model-level rotation for Langdock, the single-provider
 * replacement for the provider-level failover chain removed on 2026-08-18.
 *
 * WHY THIS EXISTS
 * Each approved Langdock model has its own quota (500 requests / 250k tokens),
 * so the four models on `LANGDOCK_ALLOWED_MODELS` are four independent
 * capacity buckets. Exhausting one is not an outage; it is a reason to use the
 * next. ADR-006 recorded this as the open follow-up to the allowlist work.
 *
 * WHAT ROTATES, AND WHAT DOES NOT
 * Rotation is deliberately narrow. A model is retried on the next model only
 * when the failure is attributable to *that model*:
 *
 *   - HTTP 429 — the per-model quota or rate limit. The whole reason this
 *     exists.
 *   - HTTP 400 whose provider detail complains about the model — what Langdock
 *     returns when a model is retired from its catalogue ("Invalid model,
 *     available models are: ..."). Rotating past it keeps drafts flowing while
 *     the allowlist is corrected.
 *
 * Everything else fails straight through, unchanged:
 *
 *   - 401 / 403 are account-level. Every model would fail identically, so
 *     rotating would turn one auth failure into four.
 *   - A 400 that is not about the model means *our request* is malformed.
 *     Rotating burns every model's quota to receive the same rejection.
 *   - Timeouts, network failures and 5xx are transport- or gateway-level, not
 *     model-level. The worker's PGMQ retry policy already handles those, and
 *     retrying later is the correct response; rotating is not.
 *
 * This keeps the transient/terminal classification in
 * `apps/worker/src/draft-rpc-error-codes.ts` exactly as it was: rotation
 * happens strictly *inside* one provider call, and whatever error finally
 * escapes carries the same category it would have carried without rotation.
 *
 * LATENCY BUDGET
 * Rotation shares the caller's AbortSignal — the orchestrator's 25-second
 * budget covers all attempts together, not each one. Worst-case single-attempt
 * latency therefore stays 25s (ADR-006, consequence 3) instead of becoming
 * 4x25s. A 429 comes back immediately, so in the case rotation is actually for,
 * the cost is negligible.
 */

import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';
import { ProviderError } from './errors';
import {
  LANGDOCK_ALLOWED_MODELS,
  LangdockAdapter,
  assertAllowedLangdockModel,
  type LangdockConfig,
  type LangdockModel,
} from './langdock';

/**
 * Provider complaints that mean "not this model" rather than "not this
 * request". Matched against the sanitized `providerDetail`, which contains
 * only the provider's own structured error fields.
 */
const MODEL_REJECTION_PATTERN = /invalid model|unknown model|model not found|no such model|model .{0,40}(does not exist|is not available)/i;

/**
 * Should this failure be retried on the next model?
 *
 * @see the file header for why the set is this narrow.
 */
export function isRotatableProviderError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;

  // Per-model quota / rate limit — the case rotation exists for.
  if (err.category === 'HTTP_429') return true;

  // A model retired from the provider's catalogue. Only when the provider
  // said so: a 400 with no model complaint is our own malformed request.
  if (err.category === 'HTTP_400') {
    return err.providerDetail !== undefined && MODEL_REJECTION_PATTERN.test(err.providerDetail);
  }

  return false;
}

/**
 * Parse an ordered, comma-separated model list from configuration.
 *
 * Every entry must be on `LANGDOCK_ALLOWED_MODELS`; the list is a rotation
 * order, never a way around the cost allowlist.
 *
 * @throws ProviderError INVALID_CONFIGURATION — terminal, so a misconfigured
 * deployment archives immediately with the reason recorded rather than
 * retrying or spending money.
 */
export function parseLangdockModelList(raw: string, provider = 'langdock'): LangdockModel[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new ProviderError(
      provider,
      'INVALID_CONFIGURATION',
      undefined,
      `Model list is empty. Give an ordered, comma-separated list of: ${LANGDOCK_ALLOWED_MODELS.join(', ')}.`
    );
  }

  for (const entry of entries) {
    // Throws INVALID_CONFIGURATION naming the offending model.
    assertAllowedLangdockModel(entry, provider);
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      // A duplicate is a typo, and it would silently halve the effective
      // rotation depth. Fail rather than dedupe.
      throw new ProviderError(
        provider,
        'INVALID_CONFIGURATION',
        undefined,
        `Model '${entry}' appears more than once in the rotation list.`
      );
    }
    seen.add(entry);
  }

  return entries as LangdockModel[];
}

/** Observability hook. Kept as a callback so this package needs no logger. */
export interface ModelRotationEvent {
  from: LangdockModel;
  to: LangdockModel;
  /** Error category that triggered the rotation, e.g. 'HTTP_429'. */
  category: string;
  /** Sanitized provider detail, when the provider gave one. */
  detail?: string;
  /** 1-based position of the model being abandoned. */
  attempt: number;
  /** Total models in the rotation order. */
  total: number;
}

export interface RotatingLangdockConfig extends Omit<LangdockConfig, 'defaultModel'> {
  /**
   * Rotation order, cheapest first. Must be non-empty and every entry must be
   * on the allowlist. A single-element list disables rotation, which is how a
   * deployment pins one model.
   */
  models: readonly string[];
  /** Called once per rotation. Never called on the successful attempt. */
  onRotate?: (event: ModelRotationEvent) => void;
}

/**
 * A `LangdockAdapter` that walks an ordered model list.
 *
 * Implements the same `AIProviderAdapter` contract, so `DraftOrchestrator`,
 * the fallback matrix and the worker's retry policy need no changes: from the
 * outside this is one provider call that either produces a draft or throws a
 * `ProviderError` in the usual categories.
 */
export class RotatingLangdockAdapter implements AIProviderAdapter {
  readonly providerName = 'langdock';
  private readonly adapter: LangdockAdapter;
  private readonly models: readonly LangdockModel[];
  private readonly onRotate?: (event: ModelRotationEvent) => void;

  /**
   * @throws ProviderError INVALID_CONFIGURATION if `models` is empty or
   * contains a model outside the allowlist — checked here, before any request
   * is billed.
   */
  constructor(config: RotatingLangdockConfig) {
    if (config.models.length === 0) {
      throw new ProviderError(
        'langdock',
        'INVALID_CONFIGURATION',
        undefined,
        `Rotation list is empty. Allowed models, cheapest first: ${LANGDOCK_ALLOWED_MODELS.join(', ')}.`
      );
    }

    for (const model of config.models) {
      assertAllowedLangdockModel(model, 'langdock');
    }

    this.models = config.models as readonly LangdockModel[];
    this.onRotate = config.onRotate;
    // One underlying adapter; the model is supplied per call. Its own
    // per-call allowlist check still runs, so the cost control holds even if
    // this class is bypassed or subclassed.
    this.adapter = new LangdockAdapter({
      apiKey: config.apiKey,
      endpointUrl: config.endpointUrl,
      defaultModel: this.models[0],
    });
  }

  /** The rotation order in use. */
  get rotationOrder(): readonly LangdockModel[] {
    return this.models;
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    // An explicit per-call model is an instruction, not a preference: honour
    // it exactly and do not rotate away from it.
    if (options.model) {
      return this.adapter.generateCompletion(messages, options);
    }

    const models = this.models;
    let lastError: unknown;

    for (let index = 0; index < models.length; index++) {
      const model = models[index];

      // Never start another attempt on a budget that has already run out.
      if (index > 0 && options.signal?.aborted) break;

      try {
        return await this.adapter.generateCompletion(messages, { ...options, model });
      } catch (err) {
        lastError = err;

        // Not a model-level failure: fail through unchanged, so the worker
        // sees exactly the error and category it would have seen without
        // rotation.
        if (!isRotatableProviderError(err)) throw err;

        if (index === models.length - 1) {
          // Every model rejected us for a model-level reason. Say so — the
          // dead-letter record is otherwise indistinguishable from a single
          // model being rate limited.
          throw this.exhausted(err as ProviderError);
        }

        const providerError = err as ProviderError;
        this.onRotate?.({
          from: model,
          to: models[index + 1],
          category: providerError.category,
          ...(providerError.providerDetail !== undefined
            ? { detail: providerError.providerDetail }
            : {}),
          attempt: index + 1,
          total: models.length,
        });
      }
    }

    // Reached only when the signal aborted mid-rotation: otherwise the loop
    // above always returns or throws.
    if (lastError instanceof ProviderError) throw this.exhausted(lastError, 'aborted');
    throw lastError ?? new ProviderError('langdock', 'UNKNOWN_FAILURE');
  }

  /**
   * Re-raise the last provider error with the rotation recorded.
   *
   * The category and HTTP status are preserved deliberately: the worker
   * classifies transient vs terminal from the category alone, and rotation
   * must not change that verdict. All four models rate-limited is still
   * HTTP_429, still transient, still worth retrying later — the quotas reset.
   */
  private exhausted(last: ProviderError, why: 'exhausted' | 'aborted' = 'exhausted'): ProviderError {
    const order = this.models.join(' -> ');
    const prefix =
      why === 'aborted'
        ? `aborted while rotating (${order})`
        : `all ${this.models.length} model(s) exhausted (${order})`;
    return new ProviderError(
      last.provider,
      last.category,
      last.httpStatus,
      `${prefix}; last: ${last.providerDetail ?? last.category}`
    );
  }
}
