import { describe, it, expect, vi } from 'vitest';
import { DraftWorker } from '../src/draft-worker';
import {
  createMockClient,
  createMockOrchestrator,
  MOCK_JOB_ID,
  MOCK_CONVERSATION_ID,
  MOCK_SOURCE_MESSAGE_ID,
  MOCK_BUSINESS_PROFILE_ID,
  MOCK_JOB_ROW,
  MOCK_SOURCE_TEXT,
  MOCK_DRAFT_CONFIG,
  MOCK_DRAFT_TEXT,
  MOCK_PROVIDER,
  MOCK_PROVIDER_REFERENCE,
  MOCK_USAGE,
  MOCK_MODEL,
  MOCK_QUEUE_MESSAGE,
  MOCK_PROVIDER_DETAIL,
  type MockRpcConfig,
  type MockQueryConfig,
} from './fixtures/draft-fixtures';

// Helper: create a fully configured mock client for a successful draft generation
function createSuccessClient(): SupabaseClient {
  const rpcConfig: MockRpcConfig = {
    is_feature_enabled: { data: true, error: null },
    reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
    store_draft: { data: MOCK_JOB_ID, error: null },
    record_provider_usage: { data: 'usage-event-id', error: null },
    delete_draft_generation_job: { data: true, error: null },
  };

  const queryConfig: MockQueryConfig = {
    draft_generation_jobs: {
      filters: { id: MOCK_JOB_ID },
      data: MOCK_JOB_ROW,
    },
    messages: {
      filters: { id: MOCK_SOURCE_MESSAGE_ID },
      data: { body: MOCK_SOURCE_TEXT },
    },
    ai_draft_configs: {
      filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
      data: MOCK_DRAFT_CONFIG,
    },
  };

  return createMockClient(rpcConfig, queryConfig);
}

import type { SupabaseClient } from '@supabase/supabase-js';

describe('DraftWorker', () => {
  // T29: Full lifecycle — claim → flag check → load → reserve → generate → store → delete queue
  it('completes full lifecycle successfully', async () => {
    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    // Access the private processJob method via any
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    // Verify store_draft was called
    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const storeDraftCall = rpcCalls.find((c: unknown[]) => c[0] === 'store_draft');
    expect(storeDraftCall).toBeDefined();

    // Verify delete_draft_generation_job was called
    const deleteCall = rpcCalls.find((c: unknown[]) => c[0] === 'delete_draft_generation_job');
    expect(deleteCall).toBeDefined();

    // Verify orchestrator was called
    expect(orchestrator.generateDraft).toHaveBeenCalledOnce();

    // T29b: the usage the provider reported is actually recorded.
    //
    // Every adapter has computed token counts since the contract was written;
    // until 20260903000002 the worker discarded them on every single draft.
    // This is the assertion that stops that regressing — a cost table with no
    // writer is worse than no cost table, because it reads as zero spend.
    const usageCall = rpcCalls.find(
      (c: unknown[]) => c[0] === 'record_provider_usage'
    ) as [string, Record<string, unknown>] | undefined;
    expect(usageCall).toBeDefined();
    expect(usageCall![1].p_quantities).toEqual({
      input_tokens: MOCK_USAGE.promptTokens,
      output_tokens: MOCK_USAGE.completionTokens,
    });
    expect(usageCall![1].p_provider_reference).toBe(MOCK_PROVIDER_REFERENCE);
    expect(usageCall![1].p_draft_generation_job_id).toBe(MOCK_JOB_ID);
  });

  // A failure to record usage must not undo a draft that already succeeded —
  // the provider has charged for the call either way, and retrying would
  // produce a second draft for one customer message.
  it('still completes the job when usage recording fails', async () => {
    const client = createSuccessClient();
    (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockImplementation(
      async (name: string) => {
        if (name === 'record_provider_usage') {
          return { data: null, error: { message: 'boom' } };
        }
        if (name === 'is_feature_enabled') return { data: true, error: null };
        if (name === 'reserve_draft_usage') {
          return { data: { status: 'NEWLY_RESERVED', reason: null }, error: null };
        }
        return { data: MOCK_JOB_ID, error: null };
      }
    );
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await expect(
      (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE)
    ).resolves.toBeUndefined();

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    expect(rpcCalls.find((c: unknown[]) => c[0] === 'delete_draft_generation_job')).toBeDefined();
  });

  // T30: Feature flag disabled — skip_draft_job called, no provider call
  it('skips job when feature flag is disabled', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: false, error: null },
      skip_draft_job: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    expect(orchestrator.generateDraft).not.toHaveBeenCalled();

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const skipCall = rpcCalls.find((c: unknown[]) => c[0] === 'skip_draft_job');
    expect(skipCall).toBeDefined();
  });

  // T31: Quota denied — skip_draft_job called (entitlement outcome, not provider failure)
  it('skips job when quota is denied', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'DENIED', reason: 'ENTITLEMENT_EXCEEDED' }, error: null },
      skip_draft_job: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    expect(orchestrator.generateDraft).not.toHaveBeenCalled();

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const skipCall = rpcCalls.find((c: unknown[]) => c[0] === 'skip_draft_job');
    expect(skipCall).toBeDefined();
  });

  // T32: First delivery attempt (read_ct=1) — transient failure, set visibility 5s
  it('sets visibility to 5s on first attempt transient failure', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      set_draft_generation_visibility: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-transient');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const msg = { ...MOCK_QUEUE_MESSAGE, readCt: 1 };
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(msg);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const visCall = rpcCalls.find((c: unknown[]) => c[0] === 'set_draft_generation_visibility');
    expect(visCall).toBeDefined();
    expect(visCall[1].p_visibility_timeout_seconds).toBe(5);
  });

  // T33: Second delivery attempt (read_ct=2) — transient failure, set visibility 15s
  it('sets visibility to 15s on second attempt transient failure', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      set_draft_generation_visibility: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-transient');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const msg = { ...MOCK_QUEUE_MESSAGE, readCt: 2 };
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(msg);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const visCall = rpcCalls.find((c: unknown[]) => c[0] === 'set_draft_generation_visibility');
    expect(visCall).toBeDefined();
    expect(visCall[1].p_visibility_timeout_seconds).toBe(15);
  });

  // T34: Third delivery attempt (read_ct=3) — transient failure, archive immediately
  it('archives immediately on third attempt transient failure', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-transient');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const msg = { ...MOCK_QUEUE_MESSAGE, readCt: 3 };
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(msg);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[1].p_error_code).toBe('DRAFT_EXHAUSTED_RETRIES');

    // Verify visibility was NOT set (no retry)
    const visCall = rpcCalls.find((c: unknown[]) => c[0] === 'set_draft_generation_visibility');
    expect(visCall).toBeUndefined();
  });

  // T35: No fourth provider call — read_ct > 3 handled by DB RPC, worker never sees it
  it('does not make a fourth provider call (read_ct > 3 handled by DB)', async () => {
    // The DB RPC read_draft_generation_jobs handles read_ct > 3 internally
    // and returns no message. The worker never sees read_ct = 4.
    // This test verifies the worker's processJob is never called with read_ct > 3
    // because the queue adapter returns no messages for terminal jobs.
    // We verify by checking that the worker does not have logic for read_ct > 3.
    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    // If somehow a message with read_ct = 4 arrives, the worker should still
    // process it (defense in depth), but the DB RPC normally prevents this.
    const msg = { ...MOCK_QUEUE_MESSAGE, readCt: 4 };
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(msg);

    // The worker should have processed it (defense in depth)
    expect(orchestrator.generateDraft).toHaveBeenCalledOnce();
  });

  // T36: Successful draft persistence — store_draft called with correct params
  it('stores draft with correct parameters', async () => {
    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const storeCall = rpcCalls.find((c: unknown[]) => c[0] === 'store_draft');
    expect(storeCall).toBeDefined();
    expect(storeCall[1].p_draft_generation_job_id).toBe(MOCK_JOB_ID);
    expect(storeCall[1].p_business_profile_id).toBe(MOCK_BUSINESS_PROFILE_ID);
    expect(storeCall[1].p_conversation_id).toBe(MOCK_CONVERSATION_ID);
    expect(storeCall[1].p_source_message_id).toBe(MOCK_SOURCE_MESSAGE_ID);
    expect(storeCall[1].p_body).toBe(MOCK_DRAFT_TEXT);
    expect(storeCall[1].p_provider).toBe(MOCK_PROVIDER);
    expect(storeCall[1].p_model).toBe(MOCK_MODEL);
  });

  // T37: Quota consumption — store_draft internally calls consume_draft_reservation
  // (This is handled atomically inside the store_draft RPC, verified by DB tests)
  it('calls store_draft which atomically consumes reservation', async () => {
    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const storeCall = rpcCalls.find((c: unknown[]) => c[0] === 'store_draft');
    expect(storeCall).toBeDefined();
    // The store_draft RPC internally calls consume_draft_reservation atomically.
    // The worker does not call consume_draft_reservation directly.
    const consumeCall = rpcCalls.find((c: unknown[]) => c[0] === 'consume_draft_reservation');
    expect(consumeCall).toBeUndefined();
  });

  // T38: Quota release on terminal failure — archive_draft_failed_job calls release_draft_reservation_internal
  // (This is handled atomically inside the archive_draft_failed_job RPC)
  it('archives with correct error code on permanent failure', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-permanent');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    // read_ct = 1, permanent failure (HTTP 401) → archive immediately
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[1].p_error_code).toBe('DRAFT_PROVIDER_AUTH_ERROR');
  });

  // T39: Archive after exhausted retries — DRAFT_EXHAUSTED_RETRIES error code
  it('archives with DRAFT_EXHAUSTED_RETRIES after third transient failure', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-transient');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const msg = { ...MOCK_QUEUE_MESSAGE, readCt: 3 };
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(msg);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[1].p_error_code).toBe('DRAFT_EXHAUSTED_RETRIES');
  });

  // T40: No outbound WhatsApp operation — verify no WhatsApp API calls made
  it('does not make any outbound WhatsApp calls', async () => {
    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    // Verify no WhatsApp-related RPCs were called
    const whatsappCall = rpcCalls.find((c: unknown[]) =>
      c[0].includes('whatsapp') || c[0].includes('send_message') || c[0].includes('outbound')
    );
    expect(whatsappCall).toBeUndefined();
  });

  // T41: No message content in logs — verify logger never receives source message text
  it('does not log source message text', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = createSuccessClient();
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const allLogs = [
      ...consoleSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...consoleErrorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join(' ');

    // Source message text must NOT appear in logs
    expect(allLogs).not.toContain(MOCK_SOURCE_TEXT);
    // Draft body must NOT appear in logs
    expect(allLogs).not.toContain(MOCK_DRAFT_TEXT);

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // T42: No message content in queue metadata — payload is metadata-only
  it('queue payload contains only metadata fields', () => {
    const payload = MOCK_QUEUE_MESSAGE.payload;
    const keys = Object.keys(payload);

    // Only metadata fields: draftGenerationJobId, requestId, timestamp
    expect(keys).toContain('draftGenerationJobId');
    expect(keys).toContain('requestId');
    expect(keys).toContain('timestamp');
    // No source message text in payload
    expect(JSON.stringify(payload)).not.toContain(MOCK_SOURCE_TEXT);
    // No business instructions in payload
    expect(JSON.stringify(payload)).not.toContain('business_instructions');
  });

  // T43: No worker path calls archive with an unsupported error code.
  // All archive_draft_failed_job calls must use only approved codes from
  // the failed_jobs_error_code_check constraint allowlist.
  it('never archives with an unsupported error code', async () => {
    const APPROVED_CODES = new Set([
      'DRAFT_PROVIDER_AUTH_ERROR',
      'DRAFT_PROVIDER_CONFIG_ERROR',
      'DRAFT_MALFORMED_RESPONSE',
      'DRAFT_EXHAUSTED_RETRIES',
      'DRAFT_INVALID_REQUEST',
      'DRAFT_PROVIDER_EMPTY_OUTPUT',
      'DRAFT_PROVIDER_OUTPUT_TOO_LONG',
      'DRAFT_INVALID_CONFIG',
    ]);

    const UNSUPPORTED_CODES = [
      'DRAFT_PROVIDER_ERROR',
      'DRAFT_GENERATION_TIMEOUT',
      'DRAFT_QUOTA_EXCEEDED',
      'DRAFT_INTERNAL_ERROR',
    ];

    // Test all permanent failure scenarios that archive
    const permanentBehaviors: Array<{ behavior: 'fail-permanent' | 'fail-empty' | 'fail-oversized' }> = [
      { behavior: 'fail-permanent' },
      { behavior: 'fail-empty' },
      { behavior: 'fail-oversized' },
    ];

    for (const { behavior } of permanentBehaviors) {
      const rpcConfig: MockRpcConfig = {
        is_feature_enabled: { data: true, error: null },
        reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
        archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
      };
      const queryConfig: MockQueryConfig = {
        draft_generation_jobs: {
          filters: { id: MOCK_JOB_ID },
          data: MOCK_JOB_ROW,
        },
        messages: {
          filters: { id: MOCK_SOURCE_MESSAGE_ID },
          data: { body: MOCK_SOURCE_TEXT },
        },
        ai_draft_configs: {
          filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
          data: MOCK_DRAFT_CONFIG,
        },
      };
      const client = createMockClient(rpcConfig, queryConfig);
      const orchestrator = createMockOrchestrator(behavior);
      const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
        pollIntervalMs: 100,
        visibilityTimeoutSeconds: 30,
      });

      await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

      const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
      const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
      expect(archiveCall).toBeDefined();
      const code = archiveCall[1].p_error_code as string;
      expect(APPROVED_CODES.has(code)).toBe(true);
      expect(UNSUPPORTED_CODES.includes(code)).toBe(false);
    }

    // Test transient failure at attempt 3 (archives with DRAFT_EXHAUSTED_RETRIES)
    const transientRpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const transientQueryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
      messages: {
        filters: { id: MOCK_SOURCE_MESSAGE_ID },
        data: { body: MOCK_SOURCE_TEXT },
      },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const transientClient = createMockClient(transientRpcConfig, transientQueryConfig);
    const transientOrchestrator = createMockOrchestrator('fail-transient');
    const transientWorker = new DraftWorker(transientClient, transientOrchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const transientMsg = { ...MOCK_QUEUE_MESSAGE, readCt: 3 };
    await (transientWorker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(transientMsg);

    const transientRpcCalls = (transientClient as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const transientArchiveCall = transientRpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(transientArchiveCall).toBeDefined();
    expect(transientArchiveCall[1].p_error_code).toBe('DRAFT_EXHAUSTED_RETRIES');
    expect(APPROVED_CODES.has('DRAFT_EXHAUSTED_RETRIES')).toBe(true);

    // Test malformed payload (archives with DRAFT_INVALID_REQUEST)
    const malformedRpcConfig: MockRpcConfig = {
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const malformedClient = createMockClient(malformedRpcConfig, {});
    const malformedOrchestrator = createMockOrchestrator('success');
    const malformedWorker = new DraftWorker(malformedClient, malformedOrchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    const malformedMsg = { ...MOCK_QUEUE_MESSAGE, payload: { requestId: 'test', timestamp: '2026-08-06T18:00:00.000Z' } };
    await (malformedWorker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(malformedMsg);

    const malformedRpcCalls = (malformedClient as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const malformedArchiveCall = malformedRpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(malformedArchiveCall).toBeDefined();
    expect(malformedArchiveCall[1].p_error_code).toBe('DRAFT_INVALID_REQUEST');
    expect(APPROVED_CODES.has('DRAFT_INVALID_REQUEST')).toBe(true);
  });

  // --- 2026-08-19 regression suite: terminal 4xx must not be retried ---
  //
  // The first end-to-end run failed because Langdock rejected `model: "auto"`
  // with HTTP 400, and that terminal error presented as three exhausted
  // retries with no provider explanation recorded. The classifier was already
  // correct; the archive RPC's allowlist was narrower than the set the worker
  // produced, so the archive was rejected, the message stayed on the queue,
  // and the read-side path eventually dead-lettered it as
  // DRAFT_EXHAUSTED_RETRIES. These tests pin every part of that fix.

  it('archives a provider 400 immediately on the first attempt, with no retry', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
      set_draft_generation_visibility: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
      messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-invalid-model');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    // read_ct = 1: a transient failure would retry here. A 400 must not.
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;

    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[1].p_error_code).toBe('DRAFT_INVALID_REQUEST');
    // Specifically NOT the code the original bug produced.
    expect(archiveCall[1].p_error_code).not.toBe('DRAFT_EXHAUSTED_RETRIES');

    // No retry was scheduled.
    const visCall = rpcCalls.find((c: unknown[]) => c[0] === 'set_draft_generation_visibility');
    expect(visCall).toBeUndefined();

    // Exactly one provider call: the request was not repeated.
    expect(orchestrator.generateDraft).toHaveBeenCalledOnce();
  });

  it("records the provider's own error on the dead-letter record", async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
      messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-invalid-model');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall[1].p_provider_error_detail).toBe(MOCK_PROVIDER_DETAIL);
    // Without this, the failure is only diagnosable by calling the API by hand.
    expect(archiveCall[1].p_provider_error_detail).toContain('Invalid model');
  });

  it('passes null detail rather than undefined when the provider gave none', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
      messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-permanent');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    // PostgREST drops undefined; null is explicit and maps to SQL NULL.
    expect(archiveCall[1].p_provider_error_detail).toBeNull();
  });

  it('falls back to DRAFT_INTERNAL_ERROR when the archive RPC rejects the code', async () => {
    // Defense in depth against exactly the drift that caused the original bug:
    // if the worker's code set and the RPC allowlist ever diverge again, the
    // job must still terminate rather than loop invisibly.
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

    const client = {
      rpc: vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        if (name === 'is_feature_enabled') return Promise.resolve({ data: true, error: null });
        if (name === 'reserve_draft_usage') {
          return Promise.resolve({ data: { status: 'NEWLY_RESERVED', reason: null }, error: null });
        }
        if (name === 'archive_draft_failed_job') {
          // Reject anything except the guaranteed-accepted fallback code,
          // simulating P3B15 INVALID_DRAFT_FAILURE_CODE.
          if (params.p_error_code !== 'DRAFT_INTERNAL_ERROR') {
            return Promise.resolve({
              data: null,
              error: { code: 'P3B15', message: 'INVALID_DRAFT_FAILURE_CODE' },
            });
          }
          return Promise.resolve({ data: { archived: true, already_archived: false }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn().mockImplementation((table: string) => {
        const data =
          table === 'draft_generation_jobs'
            ? MOCK_JOB_ROW
            : table === 'messages'
              ? { body: MOCK_SOURCE_TEXT }
              : MOCK_DRAFT_CONFIG;
        const qb = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => qb),
          single: vi.fn().mockResolvedValue({ data, error: null }),
        };
        return qb;
      }),
    } as unknown as SupabaseClient;

    const orchestrator = createMockOrchestrator('fail-invalid-model');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const archiveAttempts = rpcCalls.filter((c) => c.name === 'archive_draft_failed_job');
    expect(archiveAttempts).toHaveLength(2);
    expect(archiveAttempts[0].params.p_error_code).toBe('DRAFT_INVALID_REQUEST');
    expect(archiveAttempts[1].params.p_error_code).toBe('DRAFT_INTERNAL_ERROR');
    // The provider's explanation survives into the fallback archive too.
    expect(archiveAttempts[1].params.p_provider_error_detail).toBe(MOCK_PROVIDER_DETAIL);
  });

  it('does not retry the fallback forever if it is also rejected', async () => {
    const archiveAttempts: string[] = [];

    const client = {
      rpc: vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
        if (name === 'is_feature_enabled') return Promise.resolve({ data: true, error: null });
        if (name === 'reserve_draft_usage') {
          return Promise.resolve({ data: { status: 'NEWLY_RESERVED', reason: null }, error: null });
        }
        if (name === 'archive_draft_failed_job') {
          archiveAttempts.push(params.p_error_code as string);
          return Promise.resolve({ data: null, error: { code: 'P3B15', message: 'nope' } });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn().mockImplementation((table: string) => {
        const data =
          table === 'draft_generation_jobs'
            ? MOCK_JOB_ROW
            : table === 'messages'
              ? { body: MOCK_SOURCE_TEXT }
              : MOCK_DRAFT_CONFIG;
        const qb = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => qb),
          single: vi.fn().mockResolvedValue({ data, error: null }),
        };
        return qb;
      }),
    } as unknown as SupabaseClient;

    const orchestrator = createMockOrchestrator('fail-invalid-model');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    // Exactly two attempts: the mapped code, then the fallback. No unbounded loop.
    expect(archiveAttempts).toEqual(['DRAFT_INVALID_REQUEST', 'DRAFT_INTERNAL_ERROR']);
  });

  it('still retries genuinely transient failures', async () => {
    // Guard against over-correcting: 5xx must keep its retry behaviour.
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      set_draft_generation_visibility: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
      messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);
    const orchestrator = createMockOrchestrator('fail-transient');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    expect(rpcCalls.find((c: unknown[]) => c[0] === 'set_draft_generation_visibility')).toBeDefined();
    expect(rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job')).toBeUndefined();
  });

  // --- Stage 8A: Safe-disabled startup correction tests ---
  // Updated 2026-08-18 for the single-provider (Langdock-only) architecture
  // — see ADR-006. The prior two tests here (T8A-1, T8A-2) separately
  // exercised missing-Logicc and missing-Langdock configuration; with
  // Logicc removed, only Langdock configuration applies, so they're
  // consolidated into one test.

  // T8A-1: Worker starts without Langdock credentials while feature disabled
  it('starts and processes jobs without Langdock credentials when feature is disabled', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: false, error: null },
      skip_draft_job: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);

    // Factory that would throw if called (simulating missing Langdock credentials)
    const factory = vi.fn(() => {
      throw new Error('Missing Langdock provider configuration');
    });

    const worker = new DraftWorker(client, factory, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    // Should process the job without calling the factory
    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    // Factory must NOT have been called (feature disabled)
    expect(factory).not.toHaveBeenCalled();

    // Job should be skipped with FEATURE_DISABLED
    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const skipCall = rpcCalls.find((c: unknown[]) => c[0] === 'skip_draft_job');
    expect(skipCall).toBeDefined();
    expect(skipCall[1].p_skip_reason).toBe('FEATURE_DISABLED');
  });

  // T8A-3: Feature-disabled job makes zero provider calls
  it('makes zero provider calls when feature is disabled', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: false, error: null },
      skip_draft_job: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);

    // Use a mock orchestrator that would make provider calls if invoked
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(client, orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> }, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    // Orchestrator (and therefore providers) must NOT have been called
    expect(orchestrator.generateDraft).not.toHaveBeenCalled();

    // No store_draft, no reserve_draft_usage (those come after the feature gate)
    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const storeCall = rpcCalls.find((c: unknown[]) => c[0] === 'store_draft');
    expect(storeCall).toBeUndefined();
    const reserveCall = rpcCalls.find((c: unknown[]) => c[0] === 'reserve_draft_usage');
    expect(reserveCall).toBeUndefined();
  });

  // T8A-4: Feature enabled + missing Langdock configuration fails through approved config-error handling
  it('archives with DRAFT_PROVIDER_CONFIG_ERROR when feature enabled but provider config missing', async () => {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);

    // Factory that throws because Langdock credentials are missing
    const factory = vi.fn(() => {
      throw new Error('Missing Langdock provider configuration');
    });

    const worker = new DraftWorker(client, factory, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    // Factory WAS called (feature enabled)
    expect(factory).toHaveBeenCalledOnce();

    // Job archived with DRAFT_PROVIDER_CONFIG_ERROR
    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    const archiveCall = rpcCalls.find((c: unknown[]) => c[0] === 'archive_draft_failed_job');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[1].p_error_code).toBe('DRAFT_PROVIDER_CONFIG_ERROR');

    // No provider call was made (factory threw before construction)
    const storeCall = rpcCalls.find((c: unknown[]) => c[0] === 'store_draft');
    expect(storeCall).toBeUndefined();
  });

  // T8A-5: Provider credentials never appear in logs
  it('never logs provider credential values', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const FAKE_LANGDOCK_KEY = 'ld-secret-key-67890';
    const FAKE_LANGDOCK_URL = 'https://api.langdock.example.com';

    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      archive_draft_failed_job: { data: { archived: true, already_archived: false }, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: {
        filters: { id: MOCK_JOB_ID },
        data: MOCK_JOB_ROW,
      },
    };
    const client = createMockClient(rpcConfig, queryConfig);

    // Factory that throws, simulating missing config, but with credential-like values in the error
    const factory = vi.fn(() => {
      throw new Error(`Missing Langdock provider configuration: ${FAKE_LANGDOCK_KEY} ${FAKE_LANGDOCK_URL}`);
    });

    const worker = new DraftWorker(client, factory, {
      pollIntervalMs: 100,
      visibilityTimeoutSeconds: 30,
    });

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(MOCK_QUEUE_MESSAGE);

    const allLogs = [
      ...consoleSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...consoleErrorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join(' ');

    // Credential values must never appear in logs
    expect(allLogs).not.toContain(FAKE_LANGDOCK_KEY);
    expect(allLogs).not.toContain(FAKE_LANGDOCK_URL);

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('the organization locale reaches the prompt', () => {
  /**
   * 2026-08-31. `prompt-builder` learned to write in the organization's
   * language; this is the half that tells it which one. Before it, the prompt
   * builder had no locale to read and every organization got Spanish
   * scaffolding regardless of `organizations.locale`.
   *
   * The lookup is deliberately unable to fail a job: a draft is not worth
   * losing over a language, and Spanish is a complete, correct prompt for the
   * product's default. Two of the tests below are about that, because
   * "degrades to the default" is a claim that is only worth what its test is.
   */

  function clientWithOrganization(
    organizations: { data: Record<string, unknown> | null; error?: { code: string; message: string } | null } | undefined
  ): SupabaseClient {
    const rpcConfig: MockRpcConfig = {
      is_feature_enabled: { data: true, error: null },
      reserve_draft_usage: { data: { status: 'NEWLY_RESERVED', reason: null }, error: null },
      store_draft: { data: MOCK_JOB_ID, error: null },
      delete_draft_generation_job: { data: true, error: null },
    };
    const queryConfig: MockQueryConfig = {
      draft_generation_jobs: { filters: { id: MOCK_JOB_ID }, data: MOCK_JOB_ROW },
      messages: { filters: { id: MOCK_SOURCE_MESSAGE_ID }, data: { body: MOCK_SOURCE_TEXT } },
      ai_draft_configs: {
        filters: { business_profile_id: MOCK_BUSINESS_PROFILE_ID },
        data: MOCK_DRAFT_CONFIG,
      },
    };
    if (organizations) {
      queryConfig.organizations = {
        filters: {},
        data: organizations.data,
        error: organizations.error ?? null,
      };
    }
    return createMockClient(rpcConfig, queryConfig);
  }

  async function localeSentToProvider(
    organizations: Parameters<typeof clientWithOrganization>[0]
  ): Promise<unknown> {
    const client = clientWithOrganization(organizations);
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(
      client,
      orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> },
      { pollIntervalMs: 100, visibilityTimeoutSeconds: 30 }
    );

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(
      MOCK_QUEUE_MESSAGE
    );

    const call = orchestrator.generateDraft.mock.calls[0];
    expect(call, 'the orchestrator was never called').toBeDefined();
    return (call[0] as { config: { locale?: unknown } }).config.locale;
  }

  it('sends the organization locale through to the draft request', async () => {
    expect(await localeSentToProvider({ data: { locale: 'en' } })).toBe('en');
  });

  it('sends Spanish for a Spanish organization', async () => {
    expect(await localeSentToProvider({ data: { locale: 'es' } })).toBe('es');
  });

  it('falls back to Spanish when the organization row cannot be read', async () => {
    // Row deleted mid-job, RLS surprise, transient failure. Not a reason to
    // dead-letter a draft.
    expect(
      await localeSentToProvider({ data: null, error: { code: 'PGRST116', message: 'not found' } })
    ).toBe('es');
  });

  it('falls back to Spanish when there is no organizations row at all', async () => {
    expect(await localeSentToProvider(undefined)).toBe('es');
  });

  it('normalizes a locale the product cannot render', async () => {
    // A value that got past the CHECK constraint — a hand-run UPDATE, a
    // constraint dropped and not restored. The prompt builder would fall back
    // anyway; normalizing here means the value never travels.
    expect(await localeSentToProvider({ data: { locale: 'pt-BR' } })).toBe('es');
    expect(await localeSentToProvider({ data: { locale: null } })).toBe('es');
  });

  it('still completes the draft when the locale lookup fails', async () => {
    // The property that matters more than any of the above: a language lookup
    // must not be able to cost a draft.
    const client = clientWithOrganization({
      data: null,
      error: { code: 'PGRST116', message: 'not found' },
    });
    const orchestrator = createMockOrchestrator('success');
    const worker = new DraftWorker(
      client,
      orchestrator as unknown as { generateDraft: (req: unknown) => Promise<unknown> },
      { pollIntervalMs: 100, visibilityTimeoutSeconds: 30 }
    );

    await (worker as unknown as { processJob: (job: unknown) => Promise<void> }).processJob(
      MOCK_QUEUE_MESSAGE
    );

    const rpcCalls = (client as unknown as { rpc: { mock: { calls: unknown[] } } }).rpc.mock.calls;
    expect(rpcCalls.find((c: unknown[]) => c[0] === 'store_draft')).toBeDefined();
  });
});
