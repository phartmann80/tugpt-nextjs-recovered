# ADR-006: Provider Adapter Architecture

## Status
Provisional (Subject to Composable Capability-Based Review)

## Context
TuGPT.ai will integrate with multiple AI providers (OpenAI, Langdock, Mastra). We need a unified interface that abstracts vendor-specific SDK differences and prevents vendor lock-in.

## Decision
1. Core Contract: Define standard interface `AIProviderAdapter` in `@tugpt/ai-providers`:
   - `generateText(prompt, options)`
   - `streamText(prompt, options)`
   - `generateEmbedding(text)`
2. Implementation Adapters:
   - `OpenAIAdapter`: Direct OpenAI API wrapper.
   - `LangdockAdapter`: Langdock AI orchestration API wrapper.
   - `MastraAdapter`: Mastra AI framework adapter.
3. Factory Pattern: `AIProviderFactory.getAdapter(providerName)` resolves and instantiates the appropriate adapter based on organization configuration and feature flags.
4. Authorization Constraint: Live production API calls to external AI providers remain disabled until Phase 3 authorization.

## Consequences
- Single decoupled interface for all AI interactions.
- Allows seamless fallback or routing between AI providers.

## Security Implications
- API keys stored securely in server environment/vault and never exposed to client bundles.
- Token counts and latency recorded via `@tugpt/observability`.
