import { createAdminSupabaseClient } from '@tugpt/database';
import { PgmqAdapter } from '@tugpt/jobs';
import { processMessage, ProcessingError } from './process-message.js';
import { handleDeadLetter } from './dead-letter.js';

const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000', 10);
const VISIBILITY_TIMEOUT_SECONDS = parseInt(process.env.WORKER_VISIBILITY_TIMEOUT_SECONDS || '30', 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS || '5', 10);

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;
  const queue = new PgmqAdapter(client);

  const abortController = new AbortController();

  // Graceful shutdown
  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  console.log('Worker started. Polling whatsapp_inbound queue...');

  while (!abortController.signal.aborted) {
    try {
      const jobs = await queue.readJobs(1);

      if (jobs.length === 0) {
        await sleep(POLL_INTERVAL_MS, abortController.signal);
        continue;
      }

      for (const job of jobs) {
        await processJob(client, queue, job, abortController.signal);
      }
    } catch {
      console.error(JSON.stringify({ normalizedErrorCode: 'QUEUE_READ_ERROR', durationMs: 0 }));
      await sleep(POLL_INTERVAL_MS, abortController.signal);
    }
  }

  console.log('Worker shutting down gracefully.');
}

async function processJob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  queue: PgmqAdapter,
  job: { msgId: bigint; readCt: number; payload: Record<string, unknown> },
  _signal: AbortSignal
): Promise<void> {
  const { msgId, readCt, payload } = job;

  // Extract ONLY webhookEventId, requestId, timestamp from payload
  const webhookEventId = payload.webhookEventId as string;
  const requestId = (payload.requestId as string | null) ?? null;

  if (!webhookEventId) {
    // Malformed queue payload: dead-letter immediately
    await handleDeadLetter(client, msgId, requestId, 'INVALID_QUEUE_PAYLOAD', 1, null);
    return;
  }

  try {
    await processMessage(client, webhookEventId);

    // Success: delete the queue message
    const deleted = await queue.deleteJob(msgId);
    if (!deleted) {
      // Log-only: message remains available for redelivery
      console.error(JSON.stringify({ normalizedErrorCode: 'QUEUE_DELETE_FAILED', queueMessageId: msgId.toString() }));
    }
  } catch (err) {
    if (err instanceof ProcessingError) {
      const errorCode = err.code;

      // Check if retryable
      const isRetryable = errorCode === 'DB_TRANSIENT';

      if (isRetryable && readCt < MAX_ATTEMPTS) {
        // Record failure in separate transaction
        await recordFailure(client, webhookEventId, errorCode, readCt);

        // Extend visibility for retry
        const visibilitySet = await queue.setVisibility(msgId, VISIBILITY_TIMEOUT_SECONDS);
        if (!visibilitySet) {
          // Visibility update failed: proceed to dead-letter
          await handleDeadLetter(client, msgId, requestId, errorCode, readCt, webhookEventId);
        }
      } else {
        // Non-retryable or max attempts reached: dead-letter
        await handleDeadLetter(client, msgId, requestId, errorCode, readCt, webhookEventId);
      }
    } else {
      // Unknown error: classify as DB_TRANSIENT (transient database-processing failure)
      if (readCt < MAX_ATTEMPTS) {
        await recordFailure(client, webhookEventId, 'DB_TRANSIENT', readCt);
        const visibilitySet = await queue.setVisibility(msgId, VISIBILITY_TIMEOUT_SECONDS);
        if (!visibilitySet) {
          await handleDeadLetter(client, msgId, requestId, 'DB_TRANSIENT', readCt, webhookEventId);
        }
      } else {
        await handleDeadLetter(client, msgId, requestId, 'DB_TRANSIENT', readCt, webhookEventId);
      }
    }
  }
}

async function recordFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  webhookEventId: string,
  errorCode: string,
  attemptCount: number
): Promise<void> {
  try {
    await client.rpc('record_inbound_processing_failure', {
      p_webhook_event_id: webhookEventId,
      p_error_code: errorCode,
      p_attempt_count: attemptCount,
    });
  } catch {
    console.error(JSON.stringify({ normalizedErrorCode: 'DB_TRANSIENT', webhookEventId, attemptCount }));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

main().catch(() => {
  console.error(JSON.stringify({ normalizedErrorCode: 'QUEUE_TRANSPORT_ERROR' }));
  process.exit(1);
});