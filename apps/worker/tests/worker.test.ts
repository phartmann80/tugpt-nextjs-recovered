import { describe, it, expect, vi } from 'vitest';
import { ProcessingError, processMessage } from '../src/process-message.js';
import { handleDeadLetter } from '../src/dead-letter.js';

// Mock Supabase client
function createMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('worker process-message', () => {
  // W1: Worker polls queue and processes message successfully
  it('processes message successfully', async () => {
    const client = createMockClient({
      data: { success: true, conversation_id: 'conv-1', message_id: 'msg-1', already_processed: false },
      error: null,
    });
    const result = await processMessage(client, 'event-1');
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(false);
  });

  // W8: Redelivery after processing but before deletion is safe (idempotent)
  it('handles already-processed receipt as idempotent success', async () => {
    const client = createMockClient({
      data: { success: true, conversation_id: null, message_id: 'msg-1', already_processed: true },
      error: null,
    });
    const result = await processMessage(client, 'event-1');
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
  });

  // W2: Worker handles processing failure below max attempts (retry, no dead-letter)
  it('throws ProcessingError with DB_TRANSIENT for database errors', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'DB_TRANSIENT: connection timeout' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('DB_TRANSIENT');
    }
  });

  it('throws ProcessingError with STAGING_NOT_FOUND for missing staging', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'STAGING_NOT_FOUND: no staging row' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('STAGING_NOT_FOUND');
    }
  });

  it('throws ProcessingError with INVALID_STAGING for invalid staging', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'INVALID_STAGING: staging data corrupt' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('INVALID_STAGING');
    }
  });

  it('throws ProcessingError with UNSUPPORTED_MESSAGE_KIND for unsupported messages', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'UNSUPPORTED_MESSAGE_KIND: type not supported' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('UNSUPPORTED_MESSAGE_KIND');
    }
  });
});

describe('worker dead-letter', () => {
  it('archives failed job successfully', async () => {
    const client = createMockClient({
      data: { archived: true, already_archived: false },
      error: null,
    });
    const result = await handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1');
    expect(result.archived).toBe(true);
    expect(result.alreadyArchived).toBe(false);
  });

  it('handles already-archived as idempotent success', async () => {
    const client = createMockClient({
      data: { archived: false, already_archived: true },
      error: null,
    });
    const result = await handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1');
    expect(result.archived).toBe(false);
    expect(result.alreadyArchived).toBe(true);
  });

  it('throws on archive error', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'Archive failed' },
    });
    await expect(handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1')).rejects.toThrow();
  });
});