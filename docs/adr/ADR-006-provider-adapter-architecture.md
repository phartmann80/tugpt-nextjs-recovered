# ADR-006: Provider Adapter Architecture

## Status
Provisional

## Context
TuGPT's draft generation pipeline calls an external AI provider to produce draft responses. The adapter contract (`AIProviderAdapter`, `packages/ai-providers/src/adapter.ts`) is intentionally minimal — synchronous chat completion only — and is explicitly documented there as provisional, not frozen.

This ADR previously described a three-provider failover chain (Logicc → Langdock → Anymize), decided in ADR-012. That chain was never fully correct even as documentation — it described adapter methods (`generateDraft()`, `healthCheck()`) and error codes (`PROVIDER_TIMEOUT`, `PROVIDER_AUTH_FAILED`, etc.) that never matched the actual implementation (`generateCompletion()` and a `ProviderErrorCategory` union — see `packages/ai-providers/src/errors.ts`). This rewrite replaces that drifted content with the architecture as it actually exists, following the 2026-08-18 provider simplification decision below.

### 2026-08-18 decision: single provider, Langdock only

The owner made a final provider decision, superseding the three-provider chain:

- **Logicc: cut entirely.** Cost decision — billing was far too expensive. The `LogiccAdapter` implementation remains in the repo (`packages/ai-providers/src/logicc.ts`) but is not imported by production wiring. Deleting the file is a separate, future cleanup decision, not part of this change.
- **Anymize: removed from TuGPT.** Nothing wrong with Anymize technically — it is in active use on other, unrelated projects, and the owner does not want cross-project coupling or usage from TuGPT affecting it. TuGPT must not call Anymize under any configuration. `AnymizeAdapter` (`packages/ai-providers/src/anymize.ts`) also remains in the repo, unimported by production wiring, for the same reason as Logicc.
- **Langdock: sole provider**, and the only one required to run draft generation.
- **Model selection: auto, never pinned.** The Langdock adapter is configured with no explicit model, so it defaults to Langdock's own auto model-routing (`LANGDOCK_AUTO_MODEL = 'auto'`, the single centralized source of that default in `packages/ai-providers/src/langdock.ts`). Do not hardcode a specific model identifier anywhere in the wiring.

## Decision
1. **Adapter Pattern (unchanged)**: Each provider implements the common `AIProviderAdapter` interface (`generateCompletion()`, see `packages/ai-providers/src/adapter.ts`). Adapters live in `packages/ai-providers/`.
2. **DraftOrchestrator, single-provider configuration**: `packages/ai-orchestration/src/orchestrator.ts` still accepts `primary`, `fallback`, and `tertiary` provider slots, but production wiring (`apps/worker/src/draft-orchestrator-factory.ts`) configures only `primary` — a single `LangdockAdapter`. `fallback` and `tertiary` are left unconfigured. This is a deliberate choice to keep the fallback-capable shape intact without deleting it: see "Future: reintroducing a fallback provider" below.
3. **No in-process failover.** With only `primary` configured, `DraftOrchestrator.generateDraft()` returns the primary's error as-is on any failure — transient or terminal — since there is no next provider to hand off to. It does not consult `shouldFallback()` in that case; that function is retained for when/if a fallback is configured again.
4. **Retry and archive is the worker's job, not the orchestrator's.** `apps/worker/src/draft-worker.ts` owns the actual resilience policy for a single-provider architecture, via the PGMQ visibility-timeout retry lifecycle that already existed before this decision and did not change:
   - Transient categories (`NETWORK_FAILURE`, `TIMEOUT`, `HTTP_408`, `HTTP_429`, `HTTP_5XX`) — see `isTransientCategory()` in `apps/worker/src/draft-rpc-error-codes.ts` — set a visibility delay and retry: 5s after attempt 1, 15s after attempt 2, and archive with `DRAFT_EXHAUSTED_RETRIES` after attempt 3.
   - Terminal categories (`HTTP_400/401/403/404/422`, `INVALID_CONFIGURATION`, `INVALID_REQUEST`, `MALFORMED_PROVIDER_RESPONSE`, `EMPTY_OUTPUT`, `OUTPUT_TOO_LONG`, and any unclassified `UNKNOWN_FAILURE`) archive immediately via `mapProviderErrorToDbCode()`.
   - This classification and the retry/archive mechanics are unchanged by the single-provider decision; they were already provider-agnostic (they operate on `ProviderErrorCategory`, never on a provider name), which is why removing Logicc and Anymize required no changes to `draft-worker.ts`, `draft-rpc-error-codes.ts`, or `fallback-matrix.ts`.
5. **25-Second Abort**: Each provider call is wrapped in an `AbortController` with a 25-second timeout (`packages/ai-orchestration/src/orchestrator.ts`). In the single-provider configuration, one draft generation attempt has a worst case of 25 seconds, not the 75-second (3×25s) worst case the old three-provider chain had.
6. **Content Privacy (unchanged)**: Adapters return only generated content and sanitized metadata. No raw provider response bodies, headers, or API keys are logged. The `Logger` (ADR-009) sanitizes context values and `err.message`.
7. **Configuration**: Langdock is configured via `LANGDOCK_API_CODE` (required) and `LANGDOCK_ENDPOINT_URL` (optional, defaults to `https://api.langdock.com/openai/eu/v1`). No `LOGICC_*` or `ANYMIZE_*` environment variables are required at worker boot, or at any point — see `apps/worker/src/draft-orchestrator-factory.ts`, which does not import `LogiccAdapter` or `AnymizeAdapter` at all. Provider configuration is still validated lazily, only when the worker reaches the provider-generation path (`ai_draft_generation` feature flag enabled for the organization), so the worker starts and polls safely with zero provider credentials while the flag is off.

## Providers

| Order | Provider | Adapter | Env Prefix | Role | Status |
|-------|----------|---------|------------|------|--------|
| 1 | Langdock | `LangdockAdapter` | `LANGDOCK_*` | Sole draft generation provider | Active |
| — | Logicc | `LogiccAdapter` | `LOGICC_*` | — | Removed (cost). Adapter code retained, unused. |
| — | Anymize | `AnymizeAdapter` | `ANYMIZE_*` | — | Removed (cross-project isolation). Adapter code retained, unused. |

## Future: reintroducing a fallback provider
This is explicitly an open option, not a closed door. `DraftOrchestrator` still accepts `fallback` and `tertiary`, `shouldFallback()` (`packages/ai-orchestration/src/fallback-matrix.ts`) still classifies every `ProviderErrorCategory` into `FALLBACK_ALLOWED`/`FALLBACK_PROHIBITED`, and the `AIProviderAdapter` interface is provider-agnostic. Reintroducing a fallback later requires only: implementing or reusing an adapter, and passing it as `fallback` (and optionally `tertiary`) from `apps/worker/src/draft-orchestrator-factory.ts` — no interface or orchestrator change needed. Anymize specifically must not be that reintroduced fallback without a separate, explicit decision reversing the 2026-08-18 cross-project isolation call.

## Consequences
- **Single point of failure, accepted.** With no fallback configured, a Langdock outage or sustained rate-limiting halts draft generation until Langdock recovers — there is no other provider to fail over to. The owner accepted this risk explicitly on 2026-08-18. The worker-level retry-then-archive policy (item 4 above) is what makes this acceptable operationally: jobs retry on the existing PGMQ schedule and archive cleanly with `DRAFT_EXHAUSTED_RETRIES` rather than being silently lost, and can be redriven once Langdock recovers.
- **Lower cost and operational surface.** One provider to monitor, one set of credentials to rotate, no cross-project coupling risk from Anymize.
- **Bounded latency reduced.** Worst-case single-attempt latency drops from 75s (three chained 25s timeouts) to 25s.
- **No configuration overhead for unused providers.** `LOGICC_*` and `ANYMIZE_*` variables are not read by worker startup or the provider-generation path at all.
- **Extensibility preserved.** Adding a provider back — Logicc, Anymize, or a new one — requires only implementing/reusing the adapter interface and wiring it into `draft-orchestrator-factory.ts`. No changes to `DraftOrchestrator`, `draft-worker.ts`, or the retry/archive policy.
