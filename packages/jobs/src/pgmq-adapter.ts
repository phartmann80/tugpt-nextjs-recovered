import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PGMQ adapter for the whatsapp_inbound queue.
 * All queue operations go through service-role Supabase RPCs.
 */
export class PgmqAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Read messages from the whatsapp_inbound queue.
   * Returns up to p_limit messages with their delivery counts.
   */
  async readJobs(limit: number = 1): Promise<
    Array<{
      msgId: bigint;
      readCt: number;
      payload: Record<string, unknown>;
      enqueuedAt: string;
      vt: string;
    }>
  > {
    const { data, error } = await this.client.rpc('read_whatsapp_inbound_jobs', {
      p_limit: limit,
    });

    if (error) {
      throw new QueueReadError(error.message);
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return [];
    }

    const rows = Array.isArray(data) ? data : [data];
    return rows.map((row: Record<string, unknown>) => ({
      msgId: BigInt(row.msg_id as string | number),
      readCt: row.read_ct as number,
      payload: row.payload as Record<string, unknown>,
      enqueuedAt: row.enqueued_at as string,
      vt: row.vt as string,
    }));
  }

  /**
   * Delete a message from the queue after successful processing.
   * Returns true if the message was deleted, false otherwise.
   */
  async deleteJob(msgId: bigint): Promise<boolean> {
    const { data, error } = await this.client.rpc('delete_whatsapp_inbound_job', {
      p_msg_id: msgId.toString(),
    });

    if (error) {
      throw new QueueDeleteError(error.message);
    }

    return data === true;
  }

  /**
   * Extend the visibility timeout for a message (for retry).
   * Returns true if the visibility was extended, false otherwise.
   */
  async setVisibility(msgId: bigint, visibilityTimeoutSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_whatsapp_inbound_visibility', {
      p_msg_id: msgId.toString(),
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
    });

    if (error) {
      throw new QueueVisibilityError(error.message);
    }

    return data === true;
  }
}

export class QueueReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueReadError';
  }
}

export class QueueDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueDeleteError';
  }
}

export class QueueVisibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueVisibilityError';
  }
}