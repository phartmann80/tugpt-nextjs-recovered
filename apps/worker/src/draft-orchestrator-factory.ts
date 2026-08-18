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
 * Model selection: Langdock is configured with no `defaultModel` override,
 * so LangdockAdapter falls back to LANGDOCK_AUTO_MODEL ('auto') — Langdock's
 * own auto model-routing. Do not pin an individual model here or anywhere
 * else; that constant is the single centralized source of the default.
 *
 * Called lazily: this factory only runs once the worker reaches the
 * provider-generation path (ai_draft_generation feature flag enabled for
 * the organization). This keeps startup and polling safe with zero
 * provider credentials present while the flag is off. If required
 * configuration is missing, this throws and the caller
 * (apps/worker/src/draft-worker.ts) archives the job through the approved
 * DRAFT_PROVIDER_CONFIG_ERROR path. Credential values are never logged.
 */

import { LangdockAdapter } from '@tugpt/ai-providers';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';

/**
 * Build the DraftOrchestrator from environment variables.
 *
 * @param env - Defaults to `process.env`. Accepting it as a parameter keeps
 * this function pure and unit-testable without mutating global process env.
 * @throws Error if LANGDOCK_API_CODE is missing.
 */
export function buildDraftOrchestrator(env: NodeJS.ProcessEnv = process.env): DraftOrchestrator {
  const langdockApiKey = env.LANGDOCK_API_CODE;

  if (!langdockApiKey) {
    throw new Error('Missing Langdock provider configuration');
  }

  const provider = new LangdockAdapter({
    apiKey: langdockApiKey,
    endpointUrl: env.LANGDOCK_ENDPOINT_URL,
    // No defaultModel override — see the file header on auto model routing.
  });

  return new DraftOrchestrator({ primary: provider });
}
