# ADR-014: PGMQ as the Production Queue Backend

## Status
Accepted

## Context
ADR-007 defined the `JobQueueAdapter` abstraction and named two candidate production backends — "BullMQ / Redis or Supabase PgBoss" — without picking one. That ambiguity was left open deliberately at the time and has sat unresolved since.

In practice, the Phase 3A (`whatsapp_inbound`) and Phase 3B (`draft_generation`) implementations never used BullMQ or PgBoss. Both were built directly on **PGMQ** (the `pgmq` Postgres extension, installed and owned inside the same Supabase/Postgres database as the rest of the schema):

- `supabase/migrations/20260804000008_setup_pgmq.sql` — installs the `pgmq` extension and creates the `whatsapp_inbound` queue, with `pgmq` schema access restricted to `service_role` (revoked from `PUBLIC`, `anon`, `authenticated`).
- `supabase/migrations/20260805000010_create_draft_generation_queue.sql` — creates the `draft_generation` queue on the same extension.
- Application code never talks to the `pgmq` schema directly. All reads/writes go through `SECURITY DEFINER` RPC wrappers (e.g. `read_whatsapp_inbound_jobs`, `delete_whatsapp_inbound_job`, `read_draft_generation_jobs`, `set_draft_generation_visibility`, `archive_draft_failed_job`), consistent with ADR-004's private-helper-function pattern.
- `packages/jobs/src/pgmq-adapter.ts` (`PgmqAdapter`) and `apps/worker/src/draft-queue-adapter.ts` wrap those RPCs for the two workers respectively.

This ADR closes the ADR-007 ambiguity by documenting PGMQ as the backend that is actually running in staging and is intended for production. This is a discovery/confirmation of existing reality, not a new architectural change — no code changes accompany this ADR.

## Decision
1. **PGMQ (Postgres Message Queue) is the production queue backend**, for both the `whatsapp_inbound` and `draft_generation` queues. BullMQ/Redis and Supabase PgBoss, both named as options in ADR-007, are not used and are not planned.
2. **Access is exclusively through `SECURITY DEFINER` RPC wrappers.** No application code (web, worker, or otherwise) is granted direct access to the `pgmq` schema; `service_role` alone can call into it, and only via the wrapper RPCs.
3. **Retry / archive policy differs by queue, and both are documented here as they exist today:**
   - `draft_generation` (`apps/worker/src/draft-worker.ts`): a graduated visibility-delay policy on transient failures — `read_ct = 1` → 5s delay, `read_ct = 2` → 15s delay, `read_ct = 3` → archive immediately with `DRAFT_EXHAUSTED_RETRIES` via `archive_draft_failed_job`. Terminal (non-retryable) failures archive immediately regardless of `read_ct`, via `mapProviderErrorToDbCode()`. This policy is provider-agnostic — it operates on failure classification, never on which AI provider was in play — which is why ADR-006's provider simplification (Langdock-only) required zero changes here.
   - `whatsapp_inbound` (`apps/worker/src/index.ts`): a fixed visibility timeout (`WORKER_VISIBILITY_TIMEOUT_SECONDS`, default 30s) and a fixed attempt cap (`WORKER_MAX_ATTEMPTS`, default 5), both env-overridable. On exhausting attempts or losing visibility, the job is routed to `handleDeadLetter()` (`apps/worker/src/dead-letter.ts`) rather than an "archive" RPC — a different mechanism from `draft_generation`'s archive path, not a typo. Unifying these two policies is out of scope for this ADR.
4. **Dev/test reality check:** `@tugpt/jobs` (`packages/jobs/src/types.ts`) still exports a `JobQueueAdapter` interface and an `InMemoryJobQueue` implementation, as ADR-007 originally scoped for local development and unit testing. As of this ADR, neither is actually imported anywhere outside `packages/jobs/src/types.ts` itself — worker unit tests exercise `DraftWorker` and the whatsapp inbound handler against hand-rolled Supabase RPC mocks (see `apps/worker/tests/fixtures/draft-fixtures.ts`), not through the `JobQueueAdapter`/`InMemoryJobQueue` abstraction. This is noted transparently rather than claimed as an active dev/test path; wiring it in (or removing it as dead code) is a separate future decision, not part of this ADR.

## Consequences
- Removes the open question in ADR-007 for future readers — "which backend" is now answered, not left to be inferred from what's actually deployed.
- One fewer piece of infrastructure to run and operate: no Redis, no separate queue service — PGMQ lives inside the existing Supabase Postgres instance already required for everything else.
- The `JobQueueAdapter` interface from ADR-007 is preserved conceptually (both `PgmqAdapter` and `InMemoryJobQueue` could in principle satisfy a common shape), but PGMQ is not expected to be swapped out without a new, explicit decision — this ADR is the pin, not an invitation to keep it abstract "just in case."
- `InMemoryJobQueue` being unwired is flagged here as a known gap, not fixed. A future session can decide whether to wire it into worker unit tests for a lighter-weight test double, or delete it as unused.

## Relationship to ADR-007
ADR-007 remains **Accepted** — its `JobQueueAdapter` interface design and payload-schema requirements are still correct and still followed. This ADR supersedes only the unresolved "which production backend" question ADR-007 left open, by documenting PGMQ as the answer already in use. ADR-007 is not marked Superseded (unlike ADR-012 → ADR-006); it is amended by this ADR for that one open point.

## Security Implications
Unchanged from ADR-007 and ADR-004: the `pgmq` schema is reachable only by `service_role` through `SECURITY DEFINER` RPCs; `PUBLIC`, `anon`, and `authenticated` have no direct grant. Job payloads remain non-sensitive IDs/references (message IDs, job IDs, timestamps) — no customer message content or provider credentials are ever placed on the queue itself, consistent with ADR-009's audit-logging and content-privacy requirements.
