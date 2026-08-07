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
 * (Logicc, Langdock) are validated lazily, only when the worker reaches
 * the provider-generation path (feature flag enabled). This allows safe
 * startup and polling while ai_draft_generation is disabled.
 *
 * Package scripts:
 *   dev:draft  → tsx src/draft-index.ts
 *   start:draft → node dist/draft-index.js
 */

import { createAdminSupabaseClient } from '@tugpt/database';
import { LangdockAdapter, LogiccAdapter } from '@tugpt/ai-providers';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';
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

  // Provider construction is deferred to a lazy factory.
  // The factory is called only when the worker reaches the provider-generation
  // path (ai_draft_generation feature flag enabled). If provider credentials
  // are missing, the factory throws and the worker archives the job through
  // the approved config-error path. Credential values are never logged.
  const orchestratorFactory = () => {
    const logiccApiKey = process.env.LOGICC_API_KEY;
    const logiccEndpointUrl = process.env.LOGICC_ENDPOINT_URL;
    const langdockApiKey = process.env.LANGDOCK_API_CODE;

    if (!logiccApiKey || !logiccEndpointUrl) {
      throw new Error('Missing Logicc provider configuration');
    }

    if (!langdockApiKey) {
      throw new Error('Missing Langdock fallback configuration');
    }

    const primaryProvider = new LogiccAdapter({
      apiKey: logiccApiKey,
      endpointUrl: logiccEndpointUrl,
      defaultModel: process.env.LOGICC_DEFAULT_MODEL,
    });

    const fallbackProvider = new LangdockAdapter({
      apiKey: langdockApiKey,
      endpointUrl: process.env.LANGDOCK_ENDPOINT_URL,
      defaultModel: process.env.MODEL,
    });

    return new DraftOrchestrator({
      primary: primaryProvider,
      fallback: fallbackProvider,
    });
  };

  const worker = new DraftWorker(client, orchestratorFactory, {
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