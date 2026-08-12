# ADR-006: Provider Adapter Architecture

## Status
Accepted

## Context
TuGPT's draft generation pipeline needs to call external AI providers (Logicc, Langdock, Anymize) to produce draft responses. Each provider has a different API shape, authentication method, and error vocabulary. The system must support swapping providers, adding new ones, and failing over from one to the next without changing the core orchestration logic.

## Decision
1. **Adapter Pattern**: Each provider implements a common `AIProviderAdapter` interface (`generateDraft()`, `healthCheck()`). Adapters live in `packages/ai-providers/` and are registered in a factory.
2. **DraftOrchestrator**: A central orchestrator (`packages/ai-providers/orchestrator.ts`) manages the failover chain. It calls providers in priority order (Logicc → Langdock → Anymize) and falls through to the next on failure (timeout, HTTP error, or content rejection).
3. **ProviderError Classification**: Adapters throw typed `ProviderError` instances with a `code` field (`PROVIDER_TIMEOUT`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_CONTENT_REJECTED`, `PROVIDER_UNKNOWN`). The orchestrator uses these codes to decide whether to fail over or surface the error.
4. **25-Second Abort**: Each provider call is wrapped in an `AbortController` with a 25-second timeout. If the provider does not respond within 25 seconds, the orchestrator aborts and moves to the next provider.
5. **Content Privacy**: Adapters return only the generated content and sanitized metadata. No raw provider response bodies, headers, or API keys are logged. The `Logger` (ADR-009) sanitizes all context values and error messages.
6. **Configuration**: Each provider is configured via environment variables (`*_API_KEY`, `*_ENDPOINT_URL`, `*_DEFAULT_MODEL`). The factory validates required variables at startup and throws a clear configuration error if any are missing.

## Providers

| Order | Provider | Adapter | Env Prefix | Role |
|-------|----------|---------|------------|------|
| 1 | Logicc | `LogiccAdapter` | `LOGICC_*` | Primary draft generation |
| 2 | Langdock | `LangdockAdapter` | `LANGDOCK_*` | Secondary failover |
| 3 | Anymize | `AnymizeAdapter` | `ANYMIZE_*` | Tertiary fallback |

## Consequences
- Adding a new provider requires only implementing the `AIProviderAdapter` interface and registering it in the factory. No changes to the orchestrator or calling code.
- The failover chain provides resilience: if Logicc is down or rate-limited, drafts are still generated via Langdock or Anymize.
- The 25-second abort prevents the pipeline from hanging indefinitely on a slow provider.
- Provider error codes give the orchestrator enough information to make intelligent failover decisions (e.g., retry on timeout, skip on auth failure).
- Content privacy is enforced at the adapter boundary: only sanitized content and metadata leave the adapter.