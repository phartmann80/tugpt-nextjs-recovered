import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeRpcErrorCode, type NormalizedErrorCode } from './rpc-error-codes.js';

export class ProcessingError extends Error {
  constructor(public code: NormalizedErrorCode) {
    super(code);
    this.name = 'ProcessingError';
  }
}

/**
 * Idempotent success outcomes (not errors).
 */
export interface IdempotentSuccess {
  success: true;
  conversationId: null;
  messageId: string | null;
  alreadyProcessed: true;
}

/**
 * Processing result for a newly processed message.
 */
export interface ProcessingSuccess {
  success: true;
  conversationId: string;
  messageId: string;
  alreadyProcessed: false;
}

/**
 * Processing failure (throws ProcessingError with a normalized code).
 */
export type ProcessResult = IdempotentSuccess | ProcessingSuccess;

/**
 * Processes an inbound WhatsApp message by calling the process_inbound_message RPC.
 *
 * Classification is based on the stable SQLSTATE code returned by the RPC
 * (error.code), never on error.message string matching.
 *
 * ALREADY_PROCESSED and DUPLICATE_MESSAGE are typed successful outcomes
 * returned as IdempotentSuccess, not exceptions.
 *
 * The raw error message is never logged or persisted.
 */
export async function processMessage(
  client: SupabaseClient,
  webhookEventId: string
): Promise<ProcessResult> {
  const { data, error } = await client.rpc('process_inbound_message', {
    p_webhook_event_id: webhookEventId,
  });

  if (error) {
    const normalizedCode = normalizeRpcErrorCode(error.code);

    // RECEIPT_NOT_FOUND and STAGING_NOT_FOUND are non-retryable ProcessingErrors
    if (normalizedCode === 'RECEIPT_NOT_FOUND' || normalizedCode === 'STAGING_NOT_FOUND') {
      throw new ProcessingError(normalizedCode);
    }

    // INVALID_STAGING and UNSUPPORTED_MESSAGE_KIND are non-retryable ProcessingErrors
    if (normalizedCode === 'INVALID_STAGING' || normalizedCode === 'UNSUPPORTED_MESSAGE_KIND') {
      throw new ProcessingError(normalizedCode);
    }

    // DB_TRANSIENT and any unknown code: retryable ProcessingError
    throw new ProcessingError('DB_TRANSIENT');
  }

  const result = data as { success: boolean; conversation_id: string | null; message_id: string | null; already_processed: boolean };

  if (result.already_processed) {
    return {
      success: true,
      conversationId: null,
      messageId: result.message_id,
      alreadyProcessed: true,
    } satisfies IdempotentSuccess;
  }

  return {
    success: true,
    conversationId: result.conversation_id ?? '',
    messageId: result.message_id ?? '',
    alreadyProcessed: false,
  } satisfies ProcessingSuccess;
}