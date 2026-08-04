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

  // W3: Non-retryable failure (STAGING_NOT_FOUND)
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

  // W4: Non-retryable failure (INVALID_STAGING)
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

  // W5: Non-retryable failure (UNSUPPORTED_MESSAGE_KIND)
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

  // W6: Non-retryable failure (RECEIPT_NOT_FOUND)
  it('throws ProcessingError with RECEIPT_NOT_FOUND for missing receipt', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'RECEIPT_NOT_FOUND: no receipt' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('RECEIPT_NOT_FOUND');
    }
  });

  // W7: Redelivery after processing but before acknowledgment is safe (idempotent)
  it('handles already-processed receipt as idempotent success', async () => {
    const client = createMockClient({
      data: { success: true, conversation_id: null, message_id: 'msg-1', already_processed: true },
      error: null,
    });
    const result = await processMessage(client, 'event-1');
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
  });

  // W8: Duplicate message is idempotent success (ALREADY_PROCESSED error path)
  it('handles ALREADY_PROCESSED error as idempotent success', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'ALREADY_PROCESSED: already done' },
    });
    const result = await processMessage(client, 'event-1');
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
  });

  // W9: Duplicate message idempotent success (DUPLICATE_MESSAGE error path)
  it('handles DUPLICATE_MESSAGE error as idempotent success', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'DUPLICATE_MESSAGE: already exists' },
    });
    const result = await processMessage(client, 'event-1');
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
  });

  // W10: Unknown error defaults to DB_TRANSIENT
  it('throws ProcessingError with DB_TRANSIENT for unknown errors', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'Some unknown error' },
    });
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('DB_TRANSIENT');
    }
  });

  // W11: Success result maps response fields correctly
  it('maps RPC response fields correctly', async () => {
    const client = createMockClient({
      data: { success: true, conversation_id: 'conv-uuid', message_id: 'msg-uuid', already_processed: false },
      error: null,
    });
    const result = await processMessage(client, 'event-1');
    expect(result.conversationId).toBe('conv-uuid');
    expect(result.messageId).toBe('msg-uuid');
  });
});

describe('worker dead-letter', () => {
  // D1: Archive failed job successfully
  it('archives failed job successfully', async () => {
    const client = createMockClient({
      data: { archived: true, already_archived: false },
      error: null,
    });
    const result = await handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1');
    expect(result.archived).toBe(true);
    expect(result.alreadyArchived).toBe(false);
  });

  // D2: Already-archived is idempotent success
  it('handles already-archived as idempotent success', async () => {
    const client = createMockClient({
      data: { archived: false, already_archived: true },
      error: null,
    });
    const result = await handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1');
    expect(result.archived).toBe(false);
    expect(result.alreadyArchived).toBe(true);
  });

  // D3: Archive error throws
  it('throws on archive error', async () => {
    const client = createMockClient({
      data: null,
      error: { message: 'Archive failed' },
    });
    await expect(handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1')).rejects.toThrow();
  });

  // D4: Dead-letter with null webhookEventId (INVALID_QUEUE_PAYLOAD)
  it('handles dead-letter with null webhookEventId', async () => {
    const client = createMockClient({
      data: { archived: true, already_archived: false },
      error: null,
    });
    const result = await handleDeadLetter(client, 999n, null, 'INVALID_QUEUE_PAYLOAD', 1, null);
    expect(result.archived).toBe(true);
  });

  // D5: Sanitized logging — error.message is not logged
  it('does not log raw error message on failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sensitiveData = 'phone=+15551234567&secret=abc123&sql=DROP TABLE';
    const client = createMockClient({
      data: null,
      error: { message: sensitiveData },
    });
    await expect(handleDeadLetter(client, 123n, 'req-1', 'DB_TRANSIENT', 5, 'event-1')).rejects.toThrow();
    // Verify the raw error message was NOT logged
    const loggedArgs = consoleSpy.mock.calls.map(c => JSON.stringify(c)).join(' ');
    expect(loggedArgs).not.toContain(sensitiveData);
    expect(loggedArgs).not.toContain('+15551234567');
    expect(loggedArgs).not.toContain('abc123');
    expect(loggedArgs).not.toContain('DROP TABLE');
    consoleSpy.mockRestore();
  });
});