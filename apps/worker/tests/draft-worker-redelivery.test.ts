/**
 * @file draft-worker-redelivery.test.ts
 * @description What happens when a queue message outlives the job it belongs to.
 *
 * processJob() branches on the reservation status with a single check:
 *
 *   const reservation = await this.reserveQuota(draftGenerationJobId);
 *   if (reservation.status === 'DENIED') { skip; return; }
 *   // ... everything else falls through and calls the provider
 *
 * `reserve_draft_usage` has five outcomes, not two. Three of them mean "carry
 * on" and two of them mean "this job is finished, you are looking at a stale
 * message" — and the two were being treated as the three.
 *
 * The window that produces a stale message is narrow but entirely ordinary:
 * store_draft succeeds, and then queue.deleteJob does not. A dropped
 * connection does it. So does SIGKILL at the end of stop_grace_period, which
 * is exactly what happens to this worker on a deploy while a job is in flight.
 *
 * What followed was unbounded:
 *
 *   redelivered -> reserve returns ALREADY_CONSUMED -> ignored
 *              -> PROVIDER CALLED (real money)
 *              -> store_draft raises P3B10 (the reservation is not 'reserved')
 *              -> catch -> archiveFailed
 *              -> archive raises P3B12 (cannot archive a completed job)
 *              -> DRAFT_INTERNAL_ERROR fallback raises P3B12 too, because the
 *                 status check precedes the error-code allowlist
 *              -> "job left on the queue"
 *              -> redelivered -> ...
 *
 * Every lap costs one provider call, and nothing ever removes the message.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DraftWorker } from '../src/draft-worker';
import {
  createMockClient,
  createMockOrchestrator,
  MOCK_JOB_ID,
  MOCK_SOURCE_MESSAGE_ID,
  MOCK_BUSINESS_PROFILE_ID,
  MOCK_JOB_ROW,
  MOCK_SOURCE_TEXT,
  MOCK_DRAFT_CONFIG,
  MOCK_QUEUE_MESSAGE,
  type MockQueryConfig,
} from './fixtures/draft-fixtures';

const QUERY_CONFIG: MockQueryConfig = {
  draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
  messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
  ai_draft_configs: {
    filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
    data: MOCK_DRAFT_CONFIG,
  },
};

function rpcCalls(client: SupabaseClient): unknown[][] {
  return (client as unknown as { rpc: { mock: { calls: unknown[][] } } }).rpc.mock.calls;
}

function called(client: SupabaseClient, name: string): boolean {
  return rpcCalls(client).some((c) => c[0] === name);
}

function run(client: SupabaseClient, orchestrator: unknown, job = MOCK_QUEUE_MESSAGE) {
  const worker = new DraftWorker(
    client,
    orchestrator as { generateDraft: (req: unknown) => Promise<unknown> },
    { pollIntervalMs: 100, visibilityTimeoutSeconds: 30 }
  );
  return (worker as unknown as { processJob: (j: unknown) => Promise<void> }).processJob(job);
}

describe('DraftWorker: a queue message that outlived its job', () => {
  // The reservation was consumed, which can only mean store_draft already ran
  // and a draft already exists. Calling the provider again buys a second copy
  // of something we have, and store_draft will refuse to save it.
  it('does not call the provider when the reservation is already consumed', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'ALREADY_CONSUMED', reason: null }, error: null },
        store_draft: { data: null, error: { code: 'P3B10', message: 'INVALID_DRAFT_JOB_STATE' } },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );
    const orchestrator = createMockOrchestrator('success');

    await run(client, orchestrator);

    expect(orchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it('discards the stale message when the reservation is already consumed', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'ALREADY_CONSUMED', reason: null }, error: null },
        store_draft: { data: null, error: { code: 'P3B10', message: 'INVALID_DRAFT_JOB_STATE' } },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );

    await run(client, createMockOrchestrator('success'));

    // Not deleting it is what makes this loop forever.
    expect(called(client, 'delete_draft_generation_job')).toBe(true);
    expect(called(client, 'store_draft')).toBe(false);
  });

  // A released reservation means the job was already dead-lettered. Same
  // conclusion, different route to it.
  it('does not call the provider when the reservation was already released', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'RESERVATION_RELEASED', reason: null }, error: null },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );
    const orchestrator = createMockOrchestrator('success');

    await run(client, orchestrator);

    expect(orchestrator.generateDraft).not.toHaveBeenCalled();
    expect(called(client, 'delete_draft_generation_job')).toBe(true);
  });

  // ALREADY_RESERVED is the legitimate retry: a previous attempt reserved
  // quota and then failed before storing anything. This one must still run,
  // and asserting it here keeps the fix from over-reaching into the case it
  // was never about.
  it('still generates when the reservation exists but was never consumed', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'ALREADY_RESERVED', reason: null }, error: null },
        store_draft: { data: MOCK_JOB_ID, error: null },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );
    const orchestrator = createMockOrchestrator('success');

    await run(client, orchestrator);

    expect(orchestrator.generateDraft).toHaveBeenCalledOnce();
    expect(called(client, 'store_draft')).toBe(true);
  });
});

describe('DraftWorker: archiving a job that is already terminal', () => {
  // P3B12 is raised for a job that is already completed or skipped, and the
  // check sits above the error-code allowlist in the RPC — so retrying with
  // DRAFT_INTERNAL_ERROR raises P3B12 as well. Leaving the message queued is
  // the right instinct when an archive fails for an unknown reason. It is the
  // wrong one when the reason is "this job already finished": there is nothing
  // to archive, and the message is simply stale.
  it('discards the queue message when the archive is refused as already terminal', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
        archive_draft_failed_job: {
          data: null,
          error: { code: 'P3B12', message: 'DRAFT_ARCHIVE_STATE_ERROR' },
        },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );

    // A permanent provider failure routes straight to archiveFailed.
    await run(client, createMockOrchestrator('fail-permanent'));

    expect(called(client, 'archive_draft_failed_job')).toBe(true);
    expect(called(client, 'delete_draft_generation_job')).toBe(true);
  });

  it('does not retry the archive with DRAFT_INTERNAL_ERROR when the job is already terminal', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
        archive_draft_failed_job: {
          data: null,
          error: { code: 'P3B12', message: 'DRAFT_ARCHIVE_STATE_ERROR' },
        },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );

    await run(client, createMockOrchestrator('fail-permanent'));

    // The fallback cannot succeed here — the status check precedes the
    // error-code allowlist — so attempting it is pure noise.
    const archiveAttempts = rpcCalls(client).filter((c) => c[0] === 'archive_draft_failed_job');
    expect(archiveAttempts).toHaveLength(1);
  });

  // An archive rejected for any OTHER reason keeps the existing behaviour:
  // try DRAFT_INTERNAL_ERROR, and if that fails too, leave the message rather
  // than lose it.
  it('still falls back to DRAFT_INTERNAL_ERROR when the archive fails for another reason', async () => {
    const client = createMockClient(
      {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
        archive_draft_failed_job: {
          data: null,
          error: { code: 'P3B15', message: 'INVALID_DRAFT_FAILURE_CODE' },
        },
        delete_draft_generation_job: { data: true, error: null },
      },
      QUERY_CONFIG
    );

    await run(client, createMockOrchestrator('fail-permanent'));

    const archiveAttempts = rpcCalls(client).filter((c) => c[0] === 'archive_draft_failed_job');
    expect(archiveAttempts).toHaveLength(2);
    expect((archiveAttempts[1][1] as { p_error_code: string }).p_error_code).toBe(
      'DRAFT_INTERNAL_ERROR'
    );
    expect(called(client, 'delete_draft_generation_job')).toBe(false);
  });
});
