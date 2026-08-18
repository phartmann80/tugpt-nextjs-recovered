/**
 * @file draft-index.ts
 * @description Dedicated entry point for the draft generation worker.
 *
 * This is a SEPARATE process from the WhatsApp worker (index.ts).
 * The WhatsApp worker continues operating independently.
 *
 * Per Paul's amendment #1: do not make the default worker process run
 * both WhatsApp and draft generation concurrently. Use this dedicated
 * entry point instead.
 *
 * Per Stage 8A correction: the worker starts with only infrastructure
 * credentials (Supabase URL + service role key). Provider credentials
 * (Langdock, as of the 2026-08-18 single-provider decision — see ADR-006)
 * are validated lazily, only when the worker reaches the provider-generation
 * path (feature flag enabled). This allows safe startup and polling while
 * ai_draft_generation is disabled, with zero provider env vars required at
 * boot.
 *
 * Package scripts:
 *   dev:draft  → tsx src/draft-index.ts
 *   start:draft → node dist/draft-index.js
 */

import { createAdminSupabaseClient } from '@tugpt/database';
import { buildDraftOrchestrator } from './draft-orchestrator-factory.js';
import { DraftWorker } from './draft-worker.js';

const POLL_INTERVAL_MS = parseInt(process.env.DRAFT_WORKER_POLL_INTERVAL_MS || '5000', 10);
const VISIBILITY_TIMEOUT_SECONDS = parseInt(process.env.DRAFT_WORKER_VISIBILITY_TIMEOUT_SECONDS || '30', 10);

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({
      error: 'Missing required environment variables',
      required: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    }));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;

  // Provider construction is deferred to a lazy factory. The factory is
  // called only when the worker reaches the provider-generation path
  // (ai_draft_generation feature flag enabled). If provider credentials
  // are missing, the factory throws and the worker archives the job through
  // the approved config-error path. Credential values are never logged.
  // See draft-orchestrator-factory.ts for the single-provider (Langdock)
  // wiring and why Logicc/Anymize are not imported here.
  const worker = new DraftWorker(client, buildDraftOrchestrator, {
    pollIntervalMs: POLL_INTERVAL_MS,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  });

  const abortController = new AbortController();

  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  await worker.run(abortController.signal);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: 'Draft worker fatal error', message: (err as Error).message }));
  process.exit(1);
});