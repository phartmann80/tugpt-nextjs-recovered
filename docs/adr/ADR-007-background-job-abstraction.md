# ADR-007: Background Job Abstraction

## Status
Accepted

**Amended by [ADR-014](./ADR-014-pgmq-production-queue-backend.md) (2026-08-18):** the "production adapter" choice below was left open between BullMQ/Redis and Supabase PgBoss. ADR-014 documents that neither was used — **PGMQ** is the production backend actually running, for both the `whatsapp_inbound` and `draft_generation` queues. See ADR-014 for the concrete backend and the retry/archive policy details.

**Amended again 2026-08-25 — the interface below is not the one in use, and the code implementing it is deleted.** ADR-014 §4 flagged `JobQueueAdapter` and `InMemoryJobQueue` as unwired and left "wire it in or delete it as dead code" to a future decision. That decision is: **deleted.** `packages/jobs/src/types.ts` is gone, and with it `JobType`, `JobDefinition`, `JobHandler`, `JobQueueAdapter`, `BaseJobPayload`, `WhatsAppInboundPayload`, `InMemoryJobQueue` and the `jobQueue` singleton — every one of which had zero references anywhere in the repository, including inside its own package.

Two things this document said that were not true of the code, and are now not implied by it either:

- **"This ADR's interface design is still followed" was wrong.** Nothing implemented `JobQueueAdapter`. `PgmqAdapter` — the thing the worker actually constructs — has `readJobs`/`deleteJob`/`setVisibility` and no `enqueue` at all. Enqueueing happens in Postgres, inside the ingest RPCs, via `pgmq.send`.
- **Decision 1's signatures never matched.** It describes `enqueue<T>(queueName, jobName, payload, options)` and `process<T>(queueName, handler)`; the code had `enqueue(type, payload, options)` and no `process`.

**What the contract actually is,** for anyone arriving here looking for one: `PgmqAdapter` (`packages/jobs/src/pgmq-adapter.ts`) for the `whatsapp_inbound` reader, `apps/worker/src/draft-queue-adapter.ts` for `draft_generation`, and `pgmq.send` inside `SECURITY DEFINER` RPCs for the writer. The retry and dead-letter policies are documented in ADR-014 §3, per queue, because they genuinely differ.

The sections below are kept as the historical record of what was decided in the design phase. Read them as history, not as a description of the system.

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
