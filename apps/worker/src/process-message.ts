import type { SupabaseClient } from '@supabase/supabase-js';

export class ProcessingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ProcessingError';
  }
}

/**
 * Processes an inbound WhatsApp message by calling the process_inbound_message RPC.
 * Throws ProcessingError with a normalized error code on failure.
 */
export async function processMessage(
  client: SupabaseClient,
  webhookEventId: string
): Promise<{ success: boolean; conversationId: string | null; messageId: string | null; alreadyProcessed: boolean }> {
  const { data, error } = await client.rpc('process_inbound_message', {
    p_webhook_event_id: webhookEventId,
  });

  if (error) {
    // Map RPC error messages to normalized error codes
    const errorMsg = error.message || '';
    if (errorMsg.includes('RECEIPT_NOT_FOUND')) {
      throw new ProcessingError('RECEIPT_NOT_FOUND', errorMsg);
    }
    if (errorMsg.includes('STAGING_NOT_FOUND')) {
      throw new ProcessingError('STAGING_NOT_FOUND', errorMsg);
    }
    if (errorMsg.includes('ALREADY_PROCESSED')) {
      // Already processed is idempotent success, not an error
      return { success: true, conversationId: null, messageId: null, alreadyProcessed: true };
    }
    if (errorMsg.includes('DUPLICATE_MESSAGE')) {
      // Duplicate message is idempotent success
      return { success: true, conversationId: null, messageId: null, alreadyProcessed: true };
    }
    if (errorMsg.includes('INVALID_STAGING')) {
      throw new ProcessingError('INVALID_STAGING', errorMsg);
    }
    if (errorMsg.includes('UNSUPPORTED_MESSAGE_KIND')) {
      throw new ProcessingError('UNSUPPORTED_MESSAGE_KIND', errorMsg);
    }
    // Default: treat as DB_TRANSIENT
    throw new ProcessingError('DB_TRANSIENT', errorMsg);
  }

  const result = data as { success: boolean; conversation_id: string | null; message_id: string | null; already_processed: boolean };
  return {
    success: result.success,
    conversationId: result.conversation_id,
    messageId: result.message_id,
    alreadyProcessed: result.already_processed,
  };
}