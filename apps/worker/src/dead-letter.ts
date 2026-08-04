import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Handles dead-lettering a failed job by calling the archive_failed_job RPC.
 * This atomically inserts a failed_jobs record and archives the pgmq message.
 */
export async function handleDeadLetter(
  client: SupabaseClient,
  msgId: bigint,
  requestId: string | null,
  errorCode: string,
  attempts: number,
  webhookEventId: string | null
): Promise<{ archived: boolean; alreadyArchived: boolean }> {
  const { data, error } = await client.rpc('archive_failed_job', {
    p_msg_id: msgId.toString(),
    p_request_id: requestId,
    p_error_code: errorCode,
    p_attempts: attempts,
    p_webhook_event_id: webhookEventId,
  });

  if (error) {
    console.error(JSON.stringify({ normalizedErrorCode: 'DEAD_LETTER_FAILED', queueMessageId: msgId.toString() }));
    throw error;
  }

  const result = data as { archived: boolean; already_archived: boolean };
  return {
    archived: result.archived,
    alreadyArchived: result.already_archived,
  };
}