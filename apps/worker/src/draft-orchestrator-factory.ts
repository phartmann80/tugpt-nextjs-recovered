/**
 * @file draft-orchestrator-factory.ts
 * @description Builds the DraftOrchestrator used by the draft generation worker.
 *
 * Single-provider architecture (Langdock only), decided 2026-08-18 — see
 * ADR-006. Logicc and Anymize remain implemented as adapters
 * (packages/ai-providers/src/logicc.ts, packages/ai-providers/src/anymize.ts)
 * but are intentionally NOT imported here:
 *   - Logicc was cut entirely (cost — billing was far too expensive).
 *   - Anymize was removed from TuGPT specifically (it is used on other
 *     projects and must not be called from TuGPT under any configuration,
 *     to avoid cross-project coupling or usage bleed).
 * Reintroducing a fallback provider later requires only importing its
 * adapter and passing it as `fallback` (and optionally `tertiary`) to
 * DraftOrchestrator below — DraftOrchestrator already supports both, and
 * no interface change is needed. Do NOT import AnymizeAdapter into this
 * file for any reason without an explicit, separate decision to reverse
 * the 2026-08-18 isolation call.
 *
 * Model selection: set by `LANGDOCK_MODEL`, defaulting to
 * LANGDOCK_DEFAULT_MODEL ('gpt-5-mini'). The value is validated against
 * LANGDOCK_ALLOWED_MODELS here, at boot of the provider path, so a typo or a
 * forbidden (expensive) model fails fast with a clear configuration error
 * rather than burning retries or money. Changing the model is an env edit
 * plus a worker restart — never a code deploy.
 *
 * There is deliberately no `auto` option: Langdock's OpenAI-compatible
 * endpoint rejects `model: "auto"` with HTTP 400 invalid_request_error.
 * Verified against the live API 2026-08-19; see ADR-006.
 *
 * Called lazily: this factory only runs once the worker reaches the
 * provider-generation path (ai_draft_generation feature flag enabled for
 * the organization). This keeps startup and polling safe with zero
 * provider credentials present while the flag is off. If required
 * configuration is missing or invalid, this throws and the caller
 * (apps/worker/src/draft-worker.ts) archives the job through the approved
 * DRAFT_PROVIDER_CONFIG_ERROR path. Credential values are never logged.
 */

import {
  LangdockAdapter,
  LANGDOCK_ALLOWED_MODELS,
  LANGDOCK_DEFAULT_MODEL,
  isAllowedLangdockModel,
} from '@tugpt/ai-providers';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';

/**
 * Resolve and validate the Langdock model from the environment.
 *
 * Exported for testing and so the worker can report the effective model at
 * startup without constructing an adapter.
 *
 * @throws Error naming the offending value and the allowed set. The message
 * contains only the model name, which is not a secret.
 */
export function resolveLangdockModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LANGDOCK_MODEL?.trim();

  if (!configured) {
    return LANGDOCK_DEFAULT_MODEL;
  }

  if (!isAllowedLangdockModel(configured)) {
    throw new Error(
      `Invalid LANGDOCK_MODEL '${configured}'. Allowed models: ${LANGDOCK_ALLOWED_MODELS.join(', ')}. ` +
        `Other Langdock models are excluded on cost grounds (see ADR-006).`
    );
  }

  return configured;
}

/**
 * Build the DraftOrchestrator from environment variables.
 *
 * @param env - Defaults to `process.env`. Accepting it as a parameter keeps
 * this function pure and unit-testable without mutating global process env.
 * @throws Error if LANGDOCK_API_CODE is missing, or LANGDOCK_MODEL is set to
 * a model outside the allowlist.
 */
export function buildDraftOrchestrator(env: NodeJS.ProcessEnv = process.env): DraftOrchestrator {
  const langdockApiKey = env.LANGDOCK_API_CODE;

  if (!langdockApiKey) {
    throw new Error('Missing Langdock provider configuration');
  }

  const model = resolveLangdockModel(env);

  const provider = new LangdockAdapter({
    apiKey: langdockApiKey,
    endpointUrl: env.LANGDOCK_ENDPOINT_URL,
    defaultModel: model,
  });

  return new DraftOrchestrator({ primary: provider });
}
