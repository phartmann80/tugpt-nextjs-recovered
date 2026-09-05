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
 * That last sentence is now enforced rather than merely written:
 * `apps/worker/tests/production-never-imports-cut-providers.test.ts` fails if
 * either adapter is imported or constructed anywhere in production source.
 * A comment is invisible to someone editing a different file and survives no
 * refactor that moves this wiring; the guard covers every package, and also
 * fails if the adapters are deleted, since ADR-006 keeps them on purpose.
 *
 * MODEL SELECTION (rotation added 2026-08-19)
 *
 *   LANGDOCK_MODELS  Ordered, comma-separated rotation list, cheapest first.
 *                    On a per-model quota rejection the next model is tried
 *                    within the same attempt. Default when unset: the whole
 *                    allowlist, `gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5`.
 *   LANGDOCK_MODEL   Pins exactly one model and disables rotation. Kept for
 *                    deployments that set it before rotation existed, and as
 *                    the escape hatch for pinning. Ignored when
 *                    LANGDOCK_MODELS is also set — the more specific variable
 *                    wins, and the fact is logged rather than swallowed.
 *
 * Both are validated against LANGDOCK_ALLOWED_MODELS here, at boot of the
 * provider path, so a typo or a forbidden (expensive) model fails fast with a
 * clear configuration error rather than burning retries or money. Changing
 * models is an env edit plus a worker restart — never a code deploy.
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
  LANGDOCK_ALLOWED_MODELS,
  ProviderError,
  RotatingLangdockAdapter,
  isAllowedLangdockModel,
  parseLangdockModelList,
} from '@tugpt/ai-providers';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';
import { Logger } from '@tugpt/observability';

const logger = new Logger({ service: 'draft-worker' });

/** Which environment variable determined the model list. */
export type ModelListSource = 'LANGDOCK_MODELS' | 'LANGDOCK_MODEL' | 'default';

export interface LangdockModelResolution {
  /** Ordered rotation list. Always non-empty. */
  models: string[];
  source: ModelListSource;
  /** Set when a lower-precedence variable was present and superseded, or when rotation is off. */
  note?: string;
}

/**
 * Resolve and validate the Langdock rotation order from the environment.
 *
 * Precedence: LANGDOCK_MODELS, then LANGDOCK_MODEL, then the full allowlist.
 * Exported for testing and so the worker can report the effective order
 * without constructing an adapter.
 *
 * @throws Error naming the offending value and the allowed set. The message
 * contains only model names, which are not secrets.
 */
export function resolveLangdockModels(
  env: NodeJS.ProcessEnv = process.env
): LangdockModelResolution {
  const listRaw = env.LANGDOCK_MODELS?.trim();
  const singleRaw = env.LANGDOCK_MODEL?.trim();

  if (listRaw) {
    let models: string[];
    try {
      models = parseLangdockModelList(listRaw);
    } catch (err) {
      // parseLangdockModelList throws a terminal ProviderError. Re-raise as a
      // plain Error so every configuration failure from this factory has the
      // same shape for the caller, which archives it as
      // DRAFT_PROVIDER_CONFIG_ERROR.
      const detail = err instanceof ProviderError ? err.providerDetail : undefined;
      throw new Error(
        `Invalid LANGDOCK_MODELS '${listRaw}'. ${detail ?? 'Not a valid model list.'} ` +
          `Allowed models, cheapest first: ${LANGDOCK_ALLOWED_MODELS.join(', ')}.`
      );
    }

    const superseded =
      singleRaw && !(models.length === 1 && models[0] === singleRaw)
        ? `LANGDOCK_MODEL='${singleRaw}' is ignored because LANGDOCK_MODELS is set.`
        : undefined;

    return { models, source: 'LANGDOCK_MODELS', ...(superseded ? { note: superseded } : {}) };
  }

  if (singleRaw) {
    if (!isAllowedLangdockModel(singleRaw)) {
      throw new Error(
        `Invalid LANGDOCK_MODEL '${singleRaw}'. Allowed models: ${LANGDOCK_ALLOWED_MODELS.join(', ')}. ` +
          `Other Langdock models are excluded on cost grounds (see ADR-006).`
      );
    }
    return {
      models: [singleRaw],
      source: 'LANGDOCK_MODEL',
      note: 'Rotation is disabled: LANGDOCK_MODEL pins one model. Set LANGDOCK_MODELS to rotate.',
    };
  }

  return { models: [...LANGDOCK_ALLOWED_MODELS], source: 'default' };
}

/**
 * The model that will actually be tried first — the head of the resolved
 * order. Rotation only ever moves past it on a per-model quota rejection.
 *
 * @throws Error if the configured model is outside the allowlist.
 */
export function resolveLangdockModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveLangdockModels(env).models[0];
}

/**
 * Build the DraftOrchestrator from environment variables.
 *
 * @param env - Defaults to `process.env`. Accepting it as a parameter keeps
 * this function pure and unit-testable without mutating global process env.
 * @throws Error if LANGDOCK_API_CODE is missing, or the configured models are
 * outside the allowlist.
 */
export function buildDraftOrchestrator(env: NodeJS.ProcessEnv = process.env): DraftOrchestrator {
  const langdockApiKey = env.LANGDOCK_API_CODE;

  if (!langdockApiKey) {
    throw new Error('Missing Langdock provider configuration');
  }

  const resolution = resolveLangdockModels(env);

  logger.info('Langdock model order resolved', {
    source: resolution.source,
    models: resolution.models.join(','),
    rotation: resolution.models.length > 1 ? 'enabled' : 'disabled',
    ...(resolution.note ? { note: resolution.note } : {}),
  });

  const provider = new RotatingLangdockAdapter({
    apiKey: langdockApiKey,
    endpointUrl: env.LANGDOCK_ENDPOINT_URL,
    models: resolution.models,
    onRotate: (event) => {
      // A rotation is a real operational event: a model's quota is spent, or a
      // model has left the provider's catalogue. It must be visible even
      // though the job itself may then succeed.
      logger.info('Rotating to the next Langdock model', {
        fromModel: event.from,
        toModel: event.to,
        category: event.category,
        attempt: `${event.attempt}/${event.total}`,
        ...(event.detail ? { providerDetail: event.detail } : {}),
      });
    },
  });

  return new DraftOrchestrator({ primary: provider });
}
