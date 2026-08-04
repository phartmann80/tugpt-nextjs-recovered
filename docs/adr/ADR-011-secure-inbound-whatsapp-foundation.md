# ADR-011: Secure Inbound WhatsApp Foundation

## Status
Accepted — Phase 3A

## Context
TuGPT.ai needs a secure, reliable foundation for receiving inbound WhatsApp messages from Meta's Cloud API. The system must handle webhook verification, signature validation, message ingestion, queue-based processing, and dead-letter handling while maintaining strict multi-tenant isolation.

## Decision
Implement a layered architecture with:

1. **Webhook Route** — Validates Meta signatures (HMAC-SHA256), enforces body size and content-type limits, normalizes the envelope into individual events, and calls the ingestion RPC for each event independently.

2. **Ingestion RPC** — Resolves tenant identity from the trusted database (never from caller input), inserts a metadata-only receipt, inserts narrow typed staging data, and sends a minimal pgmq job atomically.

3. **Processing RPC** — Loads the receipt with a row lock, validates staging, finds or creates a conversation (preserving existing status), inserts a message idempotently, marks the receipt processed, and deletes staging.

4. **Queue Worker** — Polls the whatsapp_inbound queue, processes messages, handles retryable vs non-retryable errors, and dead-letters failed jobs with narrow error codes.

5. **Dead-Letter RPC** — Atomically inserts a failed_jobs record and archives the pgmq message, with idempotent deduplication.

## Key Design Principles

- **Tenant identity is always derived from the trusted database**, never from webhook payloads or queue messages.
- **No raw customer data in metadata tables** — webhook_events contains only metadata; staging contains narrow typed columns.
- **All SECURITY DEFINER functions use `SET search_path = pg_catalog`** with fully-qualified references.
- **Composite foreign keys** enforce tenant consistency at the database constraint level.
- **Error codes are normalized and separated by purpose** — route/ingestion errors never appear in failed_jobs.
- **Idempotency** is enforced via unique constraints on provider_event_key and webhook_event_id.
- **Feature flag** `whatsapp_integration` is disabled by default.

## Consequences
- The system is resilient to Meta retries via idempotent deduplication.
- Cross-tenant writes are impossible at the database constraint level.
- Service-role only access to operational tables (webhook_events, staging, failed_jobs).
- Customer-facing tables (business_profiles, whatsapp_connections, conversations, messages) have RLS with org-member SELECT and owner/admin INSERT/UPDATE.