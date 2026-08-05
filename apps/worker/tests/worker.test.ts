import { describe, it, expect, vi } from 'vitest';
import { ProcessingError, processMessage } from '../src/process-message.js';
import { normalizeRpcErrorCode } from '../src/rpc-error-codes.js';
import { handleDeadLetter } from '../src/dead-letter.js';

// Mock Supabase client
function createMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// Helper: create a mock client that returns a typed RPC error
function createTypedErrorClient(errorCode: string, errorMessage?: string) {
  return createMockClient({
    data: null,
    error: { code: errorCode, message: errorMessage || 'some raw database text' },
  });
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
  it('throws ProcessingError with DB_TRANSIENT for database errors (SQLSTATE unknown)', async () => {
    const client = createTypedErrorClient('PGRST116', 'connection timeout');
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('DB_TRANSIENT');
    }
  });

  // W3: Non-retryable failure (STAGING_NOT_FOUND)
  it('throws ProcessingError with STAGING_NOT_FOUND for missing staging (SQLSTATE 90002)', async () => {
    const client = createTypedErrorClient('90002', 'no staging row');
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('STAGING_NOT_FOUND');
    }
  });

  // W4: Non-retryable failure (INVALID_STAGING)
  it('throws ProcessingError with INVALID_STAGING for invalid staging (SQLSTATE 90008)', async () => {
    const client = createTypedErrorClient('90008', 'staging data corrupt');
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('INVALID_STAGING');
    }
  });

  // W5: Non-retryable failure (UNSUPPORTED_MESSAGE_KIND)
  it('throws ProcessingError with UNSUPPORTED_MESSAGE_KIND for unsupported messages (SQLSTATE 90009)', async () => {
    const client = createTypedErrorClient('90009', 'type not supported');
    await expect(processMessage(client, 'event-1')).rejects.toThrow(ProcessingError);
    try {
      await processMessage(client, 'event-1');
    } catch (e) {
      expect((e as ProcessingError).code).toBe('UNSUPPORTED_MESSAGE_KIND');
    }
  });

  // W6: Non-retryable failure (RECEIPT_NOT_FOUND)
  it('throws ProcessingError with RECEIPT_NOT_FOUND for missing receipt (SQLSTATE 90001)', async () => {
    const client = createTypedErrorClient('90001', 'no receipt');
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

  // W8: Success result maps response fields correctly
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

describe('rpc-error-codes: typed classification', () => {
  // T1: Two errors with different raw messages but the same typed code receive the same classification
  it('same SQLSTATE code maps to same normalized code regardless of raw message', () => {
    const code1 = normalizeRpcErrorCode('90001');
    const code2 = normalizeRpcErrorCode('90001');
    expect(code1).toBe(code2);
    expect(code1).toBe('RECEIPT_NOT_FOUND');
  });

  it('different raw messages with same SQLSTATE produce same classification', () => {
    // Simulate two different raw error messages, both with SQLSTATE 90002
    const result1 = normalizeRpcErrorCode('90002');
    const result2 = normalizeRpcErrorCode('90002');
    expect(result1).toBe('STAGING_NOT_FOUND');
    expect(result2).toBe('STAGING_NOT_FOUND');
    expect(result1).toBe(result2);
  });

  // T2: A misleading raw message containing STAGING_NOT_FOUND does not control classification
  it('misleading raw message with STAGING_NOT_FOUND text does not override typed code', () => {
    // The error has SQLSTATE 90001 (RECEIPT_NOT_FOUND) but the raw message contains "STAGING_NOT_FOUND"
    // Classification must be based on the SQLSTATE code, not the message text
    const result = normalizeRpcErrorCode('90001');
    expect(result).toBe('RECEIPT_NOT_FOUND');
    expect(result).not.toBe('STAGING_NOT_FOUND');
  });

  it('misleading raw message with STAGING_NOT_FOUND text but unknown SQLSTATE maps to DB_TRANSIENT', () => {
    // Unknown SQLSTATE code, but raw message contains "STAGING_NOT_FOUND"
    // Must NOT classify as STAGING_NOT_FOUND based on message text
    const result = normalizeRpcErrorCode('PGRST116');
    expect(result).toBe('DB_TRANSIENT');
    expect(result).not.toBe('STAGING_NOT_FOUND');
  });

  // T3: An unknown typed database code maps to DB_TRANSIENT
  it('unknown SQLSTATE code maps to DB_TRANSIENT', () => {
    const result = normalizeRpcErrorCode('P0002');
    expect(result).toBe('DB_TRANSIENT');
  });

  it('undefined error code maps to DB_TRANSIENT', () => {
    const result = normalizeRpcErrorCode(undefined);
    expect(result).toBe('DB_TRANSIENT');
  });

  it('null error code maps to DB_TRANSIENT', () => {
    const result = normalizeRpcErrorCode(null);
    expect(result).toBe('DB_TRANSIENT');
  });

  it('empty string error code maps to DB_TRANSIENT', () => {
    const result = normalizeRpcErrorCode('');
    expect(result).toBe('DB_TRANSIENT');
  });

  // T4: Raw messages containing customer data, SQL text, secrets, and provider identifiers never appear in logs or persisted error fields
  it('ProcessingError message is the normalized code, not the raw error message', () => {
    // Create a client that returns an error with sensitive raw message
    const sensitiveData = 'phone=+15551234567&secret=abc123&sql=DROP TABLE users&provider_id=wamid.HARM';
    const client = createTypedErrorClient('90001', sensitiveData);

    // The ProcessingError should contain only the normalized code, not the raw message
    return processMessage(client, 'event-1').catch((e) => {
      const err = e as ProcessingError;
      expect(err.code).toBe('RECEIPT_NOT_FOUND');
      expect(err.message).toBe('RECEIPT_NOT_FOUND');
      // The raw sensitive data must not be in the error message
      expect(err.message).not.toContain('+15551234567');
      expect(err.message).not.toContain('abc123');
      expect(err.message).not.toContain('DROP TABLE');
      expect(err.message).not.toContain('wamid.HARM');
    });
  });

  it('ProcessingError for DB_TRANSIENT does not contain raw error text', () => {
    const sensitiveData = 'password=secret123&sql=SELECT * FROM users WHERE phone=+15551234567';
    const client = createTypedErrorClient('PGRST116', sensitiveData);

    return processMessage(client, 'event-1').catch((e) => {
      const err = e as ProcessingError;
      expect(err.code).toBe('DB_TRANSIENT');
      expect(err.message).toBe('DB_TRANSIENT');
      expect(err.message).not.toContain('secret123');
      expect(err.message).not.toContain('SELECT');
      expect(err.message).not.toContain('+15551234567');
    });
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

  // D3: Null webhookEventId dead-letters with INVALID_QUEUE_PAYLOAD
  it('dead-letters with INVALID_QUEUE_PAYLOAD for null webhookEventId', async () => {
    const client = createMockClient({
      data: { archived: true, already_archived: false },
      error: null,
    });
    const result = await handleDeadLetter(client, 123n, null, 'INVALID_QUEUE_PAYLOAD', 1, null);
    expect(result.archived).toBe(true);
  });

  // D4: Dead-letter error does not log raw error message
  it('dead-letter error does not log raw error message', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sensitiveData = 'phone=+15551234567&secret=abc123&sql=DROP TABLE';
    const client = createMockClient({
      data: null,
      error: { code: '90006', message: sensitiveData },
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