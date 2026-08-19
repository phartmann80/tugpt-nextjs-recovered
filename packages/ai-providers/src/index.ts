/**
 * @file index.ts
 * @description Public surface of @tugpt/ai-providers.
 *
 * ACTIVE in production wiring: `langdock` only. TuGPT runs on Langdock as the
 * sole AI provider, with an explicit four-model cost allowlist and, since
 * 2026-08-19, model-level rotation over it (`langdock-rotation.ts`) — see
 * ADR-006 and `apps/worker/src/draft-orchestrator-factory.ts`. There is no
 * `auto` model: Langdock's OpenAI-compatible endpoint rejects it with HTTP 400.
 *
 * RETAINED BUT UNUSED: `anymize`, `logicc`, `mastra`, `openai`. These adapters
 * still implement `AIProviderAdapter` and are exported so that reintroducing a
 * provider later is a wiring change rather than a rewrite, but none of them is
 * imported by any production code path. Two of them carry explicit
 * restrictions from the 2026-08-18 provider simplification decision:
 *   - Logicc was cut entirely (cost).
 *   - Anymize must NOT be called from TuGPT under any configuration — it is
 *     used on other projects and cross-project coupling/usage bleed must be
 *     avoided. Reversing that requires a separate, explicit decision.
 *
 * The legacy `AIProviderFactory` singleton (`factory.ts`) was deleted on
 * 2026-08-18: it was unreferenced dead code, and it was the last remaining
 * reader of the `MODEL` environment variable. Model selection now lives in
 * `LANGDOCK_MODELS` / `LANGDOCK_MODEL`, resolved in the worker's orchestrator
 * factory and validated against the allowlist.
 */
export * from './adapter';
export * from './anymize';
export * from './errors';
export * from './langdock';
export * from './langdock-rotation';
export * from './logicc';
export * from './mastra';
export * from './openai';
