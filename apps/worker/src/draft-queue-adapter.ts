import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PGMQ adapter for the draft_generation queue.
 * All queue operations go through service-role Supabase RPCs.
 * Same pattern as the existing PgmqAdapter for whatsapp_inbound.
 */

export interface DraftQueueMessage {
  msgId: bigint;
  readCt: number;
  payload: Record<string, unknown>;
  enqueuedAt: string;
  vt: string;
}

export class DraftPgmqAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Read messages from the draft_generation queue.
   * The RPC reconciles draft_generation_jobs.attempts to PGMQ read_ct
   * and handles the terminal path for read_ct > 3 internally.
   */
  async readJobs(
    limit: number = 1,
    visibilityTimeoutSeconds: number = 30
  ): Promise<DraftQueueMessage[]> {
    const { data, error } = await this.client.rpc('read_draft_generation_jobs', {
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      p_limit: limit,
    });

    if (error) {
      throw new DraftQueueReadError(error.code || 'UNKNOWN');
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
   */
  async deleteJob(msgId: bigint): Promise<boolean> {
    const { data, error } = await this.client.rpc('delete_draft_generation_job', {
      p_msg_id: msgId.toString(),
    });

    if (error) {
      throw new DraftQueueDeleteError(error.code || 'UNKNOWN');
    }

    return data === true;
  }

  /**
   * Set the visibility timeout for a message (for retry).
   */
  async setVisibility(msgId: bigint, visibilityTimeoutSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_draft_generation_visibility', {
      p_msg_id: msgId.toString(),
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
    });

    if (error) {
      throw new DraftQueueVisibilityError(error.code || 'UNKNOWN');
    }

    return data === true;
  }
}

export class DraftQueueReadError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'DraftQueueReadError';
  }
}

export class DraftQueueDeleteError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'DraftQueueDeleteError';
  }
}

export class DraftQueueVisibilityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'DraftQueueVisibilityError';
  }
}