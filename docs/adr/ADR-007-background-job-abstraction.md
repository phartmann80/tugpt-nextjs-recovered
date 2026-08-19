# ADR-007: Background Job Abstraction

## Status
Accepted

**Amended by [ADR-014](./ADR-014-pgmq-production-queue-backend.md) (2026-08-18):** the "production adapter" choice below was left open between BullMQ/Redis and Supabase PgBoss. ADR-014 documents that neither was used — **PGMQ** is the production backend actually running, for both the `whatsapp_inbound` and `draft_generation` queues. See ADR-014 for the concrete backend, retry/archive policy details, and a note on `InMemoryJobQueue`'s current (unwired) state. This ADR's interface design below is otherwise unchanged and still followed.

## Context
Asynchronous processing is required for WhatsApp messaging, appointment notifications, quote generation, and background AI tasks.

## Decision
1. Queue Interface: Define `JobQueueAdapter` interface in `@tugpt/jobs`:
   - `enqueue<T>(queueName, jobName, payload, options)`
   - `process<T>(queueName, handler)`
2. Adapters:
   - `InMemoryJobQueue`: Local development and unit test queue runner.
   - Production adapter (BullMQ / Redis or Supabase PgBoss): Pluggable backend for production deployment.
3. Strict Payload Schemas: Every job payload must be strongly typed with JSON Schema / Zod validation.

## Consequences
- Decouples API handlers from async task processing.
- Supports offline testing and reliable background execution.

## Security Implications
Job payloads contain non-sensitive IDs and references. Sensitive credentials are never embedded in background job messages.
