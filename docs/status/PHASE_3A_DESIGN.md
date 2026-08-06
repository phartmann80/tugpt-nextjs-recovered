# Phase 3A: Secure Inbound WhatsApp Foundation

## Status
**Complete and merged** on Aug 5, 2026 (commit `4c6551dd`).

Implementation authorized by jp on Aug 4, 2026. Local Docker gate passed: 131 application tests, 133 pgTAP assertions, production build, and typed SQLSTATE transport check all green. Merged to main by Paul Hartmann.

## Branch
`feature/phase3a-secure-inbound-foundation` at `8130a038eee9d1993f11a88c22928384c5fdaf09` (merged)

## Scope
41 new files, 14 modified files. No AI, no outbound WhatsApp, no production deployment.

## File Inventory

### New Files (41)

**Database migrations (15)**
- `supabase/migrations/20260804000001_create_business_profiles.sql`
- `supabase/migrations/20260804000002_create_whatsapp_connections.sql`
- `supabase/migrations/20260804000003_create_webhook_events.sql`
- `supabase/migrations/20260804000004_create_inbound_message_staging.sql`
- `supabase/migrations/20260804000005_create_conversations.sql`
- `supabase/migrations/20260804000006_create_messages.sql`
- `supabase/migrations/20260804000007_create_failed_jobs.sql`
- `supabase/migrations/20260804000008_setup_pgmq.sql`
- `supabase/migrations/20260804000009_create_ingest_rpc.sql`
- `supabase/migrations/20260804000010_create_process_message_rpc.sql`
- `supabase/migrations/20260804000011_create_dead_letter_rpc.sql`
- `supabase/migrations/20260804000012_create_record_failure_rpc.sql`
- `supabase/migrations/20260804000013_create_queue_wrapper_rpcs.sql`
- `supabase/migrations/20260804000014_enable_rls_operational_tables.sql`
- `supabase/migrations/20260804000015_enable_rls_customer_facing_tables.sql`

**Database tests (8)**
- `supabase/tests/database/webhook_ingestion.test.sql`
- `supabase/tests/database/worker_processing.test.sql`
- `supabase/tests/database/dead_letter.test.sql`
- `supabase/tests/database/rls_operational_tables.test.sql`
- `supabase/tests/database/rls_customer_facing_tables.test.sql`
- `supabase/tests/database/conversation_lifecycle.test.sql`
- `supabase/tests/database/rpc_execution_permissions.test.sql`
- `supabase/tests/database/queue_wrapper_permissions.test.sql`

**Webhook route + normalizer (3)**
- `apps/web/src/app/api/v1/webhooks/whatsapp/route.ts`
- `apps/web/src/app/api/v1/webhooks/whatsapp/route.test.ts`
- `apps/web/src/lib/whatsapp-normalizer.ts`

**Normalizer tests (1)**
- `apps/web/src/lib/whatsapp-normalizer.test.ts`

**Security package (2)**
- `packages/security/src/whatsapp-signature.ts`
- `packages/security/src/whatsapp-signature.test.ts`

**Jobs package (2)**
- `packages/jobs/src/pgmq-adapter.ts`
- `packages/jobs/src/pgmq-adapter.test.ts`

**Worker app (8)**
- `apps/worker/package.json`
- `apps/worker/tsconfig.json`
- `apps/worker/eslint.config.mjs`
- `apps/worker/src/index.ts`
- `apps/worker/src/process-message.ts`
- `apps/worker/src/dead-letter.ts`
- `apps/worker/tests/worker.test.ts`

**Feature flags (1)**
- `packages/feature-flags/src/flags.test.ts`

**Documentation (2)**
- `docs/adr/ADR-011-secure-inbound-whatsapp-foundation.md`
- `docs/status/PHASE_3A_DESIGN.md`

### Modified Files (14)
- `packages/security/src/index.ts`
- `packages/jobs/src/index.ts`
- `packages/jobs/src/types.ts`
- `packages/jobs/package.json`
- `packages/feature-flags/src/flags.test.ts`
- `packages/database/src/types.ts`
- `packages/database/src/index.ts`
- `.env.example`
- `supabase/config.toml`
- `pnpm-workspace.yaml` (no change needed — already covers apps/*)
- `turbo.json`
- `package.json`
- `pnpm-lock.yaml` (updated by pnpm install)
- `apps/web/package.json` (no change needed — already has dependencies)