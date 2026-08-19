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
- **Model selection: originally specified as "auto, never pinned".** The Langdock adapter was configured with no explicit model so it would use Langdock's own auto model-routing. **This requirement is dead — see below.**

### 2026-08-19: `auto` does not exist on Langdock's OpenAI-compatible endpoint

The first end-to-end draft run failed. Verified by direct `curl` from the deployment server using the exact worker environment:

```
POST https://api.langdock.com/openai/eu/v1/chat/completions   {"model":"auto", ...}
HTTP 400
{"error":{"message":"Invalid model, available models are: gpt-5-mini, gpt-5, o3,
 gpt-5.1, o4-mini, gpt-5.6-sol, gpt-5.6-terra, gpt-5.4-mini, gpt-5.4, gpt-5.6-luna,
 gpt-5.5, gpt-5.2-pro, langdock-llama-3.3-70b-2, gpt-5.2","type":"invalid_request_error"}}
```

The API key and endpoint were valid. Langdock's OpenAI-compatible surface requires a concrete model identifier; there is no `auto` pseudo-model. **Do not reintroduce `"auto"`.** It is not a mistake to be corrected — the value does not exist on this API surface, and using it fails every request with a terminal 400.

### 2026-08-19 decision: model allowlist, env-configurable

- **`LANGDOCK_MODEL` selects the model**, defaulting to `gpt-5-mini`. Changing model is an env edit plus a worker restart — never a code deploy.
- **Exactly four models are approved**, enforced in code: `gpt-5-mini` (default), `gpt-5.1`, `gpt-5.2`, `gpt-5`. Every other model Langdock offers (`o3`, `o4-mini`, `gpt-5.4*`, `gpt-5.5`, `gpt-5.6-*`, `gpt-5.2-pro`, `langdock-llama-3.3-70b-2`) is **forbidden on cost grounds**. TuGPT moved to Langdock after cutting a provider for being too expensive, so the allowlist is a hard cost control.
- **The allowlist is enforced, not advisory.** `LANGDOCK_ALLOWED_MODELS` in `packages/ai-providers/src/langdock.ts` is checked in two places: `resolveLangdockModel()` at boot of the provider path, and `LangdockAdapter` itself (constructor *and* per-call override). A forbidden model raises `INVALID_CONFIGURATION` — a terminal category — so it archives immediately with the reason recorded rather than burning retries or money, and it cannot reach the network even if the env var says otherwise.
- **Each approved model has its own Langdock quota** (500 requests / 250k tokens), giving four independent capacity buckets. The allowlist order in code is cheapest-first because it is the intended rotation order for the follow-up below.

### 2026-08-19 decision: model-level rotation (implemented)

The four separate per-model quotas make model-level rotation the natural single-provider replacement for the provider-level failover chain removed on 2026-08-18. Implemented in `packages/ai-providers/src/langdock-rotation.ts` as `RotatingLangdockAdapter`, which implements the same `AIProviderAdapter` contract — so `DraftOrchestrator`, `fallback-matrix.ts`, `draft-worker.ts` and the retry/archive policy are unchanged. From the outside it is one provider call.

**Configuration.**

| Variable | Meaning |
|---|---|
| `LANGDOCK_MODELS` | Ordered, comma-separated rotation list, cheapest first. Every entry validated against the allowlist. Duplicates rejected — a duplicate is a typo that would silently halve the rotation depth. |
| `LANGDOCK_MODEL` | Pins exactly one model and disables rotation. The escape hatch, and back-compatible for deployments that set it before rotation existed. |
| neither set | Defaults to the whole allowlist in order: `gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5`. |

`LANGDOCK_MODELS` wins when both are set, and the fact that `LANGDOCK_MODEL` was ignored is logged. Failing the boot instead was considered and rejected: it would fire on exactly the correct upgrade action (adding `LANGDOCK_MODELS` to a host that already has `LANGDOCK_MODEL`), which is the wrong moment to be strict. Ambiguity is reported, not swallowed.

**What rotates.** Deliberately narrow — only failures attributable to *that model*:

- **HTTP 429** — the per-model quota or rate limit. The reason rotation exists.
- **HTTP 400 whose provider detail complains about the model** (`Invalid model, available models are: ...`) — what Langdock returns for a model retired from its catalogue. Rotating past it keeps drafts flowing while the allowlist is corrected. This is only reachable because `providerDetail` capture landed first.

**What does not rotate**, and why the list is short:

- **401 / 403** are account-level. Every model would fail identically, so rotating turns one auth failure into four.
- **A 400 that is not about the model** means *our request* is malformed. Rotating spends every model's quota to receive the same rejection.
- **Timeouts, network failures, 5xx** are transport- or gateway-level. The worker's PGMQ retry schedule already handles those correctly; rotating does not help and costs quota.

Whatever error finally escapes keeps its original category, so the transient/terminal classification in item 4 below is untouched. All four models rate-limited is still `HTTP_429` — still transient, still worth retrying later, because the quotas reset. When every model is exhausted the detail records that (`all 4 model(s) exhausted (gpt-5-mini -> gpt-5.1 -> ...)`), so a total exhaustion is distinguishable in `failed_jobs` from one model being briefly limited.

**Latency budget.** Rotation shares the caller's `AbortSignal`, so the orchestrator's 25-second budget covers all attempts together rather than each one. Worst-case single-attempt latency stays 25s (consequence 3 below) instead of becoming 4×25s. A 429 returns immediately, so in the case rotation is actually for, the added time is negligible.

**Per-model attribution.** The adapter returns the model that actually served the request, `store_draft` persists it to `ai_drafts.model`, and — since `20260819000003` — to `draft_generation_jobs.model` as well. `metricsCollector.recordProviderCall` is invoked per attempt with its own model, so an abandoned attempt is recorded too. Cost and quality are attributable per model without joining back through the draft.

## Decision
1. **Adapter Pattern (unchanged)**: Each provider implements the common `AIProviderAdapter` interface (`generateCompletion()`, see `packages/ai-providers/src/adapter.ts`). Adapters live in `packages/ai-providers/`.
2. **DraftOrchestrator, single-provider configuration**: `packages/ai-orchestration/src/orchestrator.ts` still accepts `primary`, `fallback`, and `tertiary` provider slots, but production wiring (`apps/worker/src/draft-orchestrator-factory.ts`) configures only `primary` — a single `LangdockAdapter`. `fallback` and `tertiary` are left unconfigured. This is a deliberate choice to keep the fallback-capable shape intact without deleting it: see "Future: reintroducing a fallback provider" below.
3. **No in-process failover.** With only `primary` configured, `DraftOrchestrator.generateDraft()` returns the primary's error as-is on any failure — transient or terminal — since there is no next provider to hand off to. It does not consult `shouldFallback()` in that case; that function is retained for when/if a fallback is configured again.
4. **Retry and archive is the worker's job, not the orchestrator's.** `apps/worker/src/draft-worker.ts` owns the actual resilience policy for a single-provider architecture, via the PGMQ visibility-timeout retry lifecycle that already existed before this decision and did not change:
   - Transient categories (`NETWORK_FAILURE`, `TIMEOUT`, `HTTP_408`, `HTTP_429`, `HTTP_5XX`) — see `isTransientCategory()` in `apps/worker/src/draft-rpc-error-codes.ts` — set a visibility delay and retry: 5s after attempt 1, 15s after attempt 2, and archive with `DRAFT_EXHAUSTED_RETRIES` after attempt 3.
   - Terminal categories (`HTTP_400/401/403/404/422`, `INVALID_CONFIGURATION`, `INVALID_REQUEST`, `MALFORMED_PROVIDER_RESPONSE`, `EMPTY_OUTPUT`, `OUTPUT_TOO_LONG`, and any unclassified `UNKNOWN_FAILURE`) archive immediately via `mapProviderErrorToDbCode()` — no retries, since a 4xx request error fails identically every time.
   - This classification and the retry/archive mechanics are unchanged by the single-provider decision; they were already provider-agnostic (they operate on `ProviderErrorCategory`, never on a provider name), which is why removing Logicc and Anymize required no changes to `draft-worker.ts`, `draft-rpc-error-codes.ts`, or `fallback-matrix.ts`.
   - **2026-08-19 correction.** The classification above was correct in code, but terminal archiving did not actually work end to end. `private.archive_draft_failed_job` carried its own allowlist of five error codes, while the worker produced eight. So a terminal archive (e.g. `DRAFT_INVALID_REQUEST` for the Langdock 400) was rejected with `P3B15 INVALID_DRAFT_FAILURE_CODE`, `archiveFailed()` logged and swallowed it, and the queue message was left neither archived nor deleted. It was redelivered until `read_ct` exceeded the limit, at which point `read_draft_generation_jobs` dead-lettered it as `DRAFT_EXHAUSTED_RETRIES`. A terminal 400 therefore presented as three exhausted retries with no provider explanation recorded. Migration `20260819000001` aligns the allowlists; the worker now falls back to `DRAFT_INTERNAL_ERROR` if an archive is ever rejected again, so a code drift can never again turn into a silent retry loop. **The worker's `DraftErrorCode` union must remain a subset of that RPC's allowlist.**
   - **Provider errors are now captured.** `ProviderError.providerDetail` carries a short, sanitized description of the provider's own complaint, persisted to `failed_jobs.provider_error_detail` and included in the "Provider failure" log line. Only the provider's structured error fields (`error.message` / `error.type` / `error.code`) are extracted — never the raw response body — then credential-shaped substrings are redacted and the result is capped at 300 characters, so it cannot become a path for prompts or customer content to reach storage. This is the difference between diagnosing an invalid-model rejection from the logs and having to reproduce it by hand against the live API.
5. **25-Second Abort**: Each provider call is wrapped in an `AbortController` with a 25-second timeout (`packages/ai-orchestration/src/orchestrator.ts`). In the single-provider configuration, one draft generation attempt has a worst case of 25 seconds, not the 75-second (3×25s) worst case the old three-provider chain had.
6. **Content Privacy (unchanged)**: Adapters return only generated content and sanitized metadata. No raw provider response bodies, headers, or API keys are logged. The `Logger` (ADR-009) sanitizes context values and `err.message`.
7. **Configuration**: Langdock is configured via `LANGDOCK_API_CODE` (required), `LANGDOCK_ENDPOINT_URL` (optional, defaults to `https://api.langdock.com/openai/eu/v1`), and the model selection above — `LANGDOCK_MODELS` (optional ordered rotation list) or `LANGDOCK_MODEL` (optional, pins one model), both validated against the allowlist at boot, defaulting to the full allowlist in cheapest-first order. No `LOGICC_*` or `ANYMIZE_*` environment variables are required at worker boot, or at any point — see `apps/worker/src/draft-orchestrator-factory.ts`, which does not import `LogiccAdapter` or `AnymizeAdapter` at all. Provider configuration is still validated lazily, only when the worker reaches the provider-generation path (`ai_draft_generation` feature flag enabled for the organization), so the worker starts and polls safely with zero provider credentials while the flag is off.

## Providers

| Order | Provider | Adapter | Env Prefix | Role | Status |
|-------|----------|---------|------------|------|--------|
| 1 | Langdock | `RotatingLangdockAdapter` over `LangdockAdapter` | `LANGDOCK_*` | Sole draft generation provider, rotating over the four approved models | Active |
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
