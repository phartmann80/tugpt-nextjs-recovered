# ADR-012: Three-Provider Failover Chain

## Status
Accepted

## Context
Phase 3B introduced AI draft generation with a single provider (Langdock). Production reliability requires that a draft request still succeeds when the primary provider is down, rate-limited, or returning errors. A single-provider design creates a hard dependency on one external service with no fallback.

## Decision
Implement a three-provider failover chain in the `DraftOrchestrator`:

1. **Chain order**: Logicc (primary) → Langdock (secondary) → Anymize (tertiary). The orchestrator calls providers in this order and falls through to the next on any failure.
2. **Failover triggers**: The orchestrator moves to the next provider when:
   - The provider call times out (25-second `AbortController` per provider).
   - The provider returns an HTTP error (5xx, 429 rate limit, 401/403 auth failure).
   - The provider returns content that fails validation (empty, malformed, or rejected by content policy).
3. **Error classification**: Each adapter throws a typed `ProviderError` with a `code` field. The orchestrator uses the code to decide failover vs. surface:
   - `PROVIDER_TIMEOUT` → fail over
   - `PROVIDER_AUTH_FAILED` → fail over (likely misconfigured, but try next)
   - `PROVIDER_RATE_LIMITED` → fail over
   - `PROVIDER_CONTENT_REJECTED` → fail over
   - `PROVIDER_UNKNOWN` → fail over
   - If all three providers fail, the last error is surfaced to the caller.
4. **25-second abort**: Each provider call is wrapped in an `AbortController` with a 25-second timeout. This prevents the pipeline from hanging indefinitely and ensures the total worst-case latency is bounded at 75 seconds (3 × 25s).
5. **Logging**: Each failover event is logged at `warn` level with the provider name, error code, and elapsed time. No API keys, response bodies, or sensitive headers are logged (per ADR-009 secret sanitization, including `err.message` sanitization from PR #2).

## Consequences
- **Resilience**: Draft generation succeeds as long as at least one of the three providers is operational.
- **Bounded latency**: Worst-case latency is 75 seconds (3 × 25s timeout), preventing unbounded hangs.
- **Operational visibility**: Failover events are logged with enough detail to identify which provider is consistently failing, without leaking secrets.
- **Extensibility**: Adding a fourth provider requires only implementing the adapter interface and adding it to the chain in the orchestrator. No changes to calling code.
- **Configuration overhead**: Three sets of environment variables must be managed (`LOGICC_*`, `LANGDOCK_*`, `ANYMIZE_*`). Missing configuration for a provider causes the factory to skip it and log a warning, rather than crashing.