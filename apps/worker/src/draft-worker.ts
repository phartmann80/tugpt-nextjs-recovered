/**
 * @file draft-worker.ts
 * @description Draft generation worker: polls the draft_generation PGMQ queue,
 * verifies feature flag, loads job context, reserves quota, calls the
 * DraftOrchestrator, stores the draft, and handles retry/archive/skip.
 *
 * Never sends outbound WhatsApp messages. Drafts are stored for human review.
 *
 * Content privacy: source message text, prompts, business instructions,
 * draft body, provider response body, phone identifiers, authorization
 * headers, and provider credentials are NEVER logged. Only sanitized
 * metadata is logged: requestId, draftGenerationJobId, provider name,
 * model, normalized error category, latency, attempt number.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@tugpt/observability';
import { DraftPgmqAdapter } from './draft-queue-adapter.js';
import { DraftOrchestrator } from '@tugpt/ai-orchestration';
import type { DraftRequest, DraftConfig } from '@tugpt/ai-orchestration';
import type { ProviderErrorCategory } from '@tugpt/ai-providers';
import { mapProviderErrorToDbCode, type DraftErrorCode } from './draft-rpc-error-codes.js';

/** Retry visibility delays per Paul's amendment #7. */
const RETRY_DELAY_1 = 5;   // read_ct = 1 failure → 5 seconds
const RETRY_DELAY_2 = 15;  // read_ct = 2 failure → 15 seconds
// read_ct = 3 failure → archive immediately with DRAFT_EXHAUSTED_RETRIES

const logger = new Logger({ service: 'draft-worker' });

export interface DraftWorkerConfig {
  pollIntervalMs: number;
  visibilityTimeoutSeconds: number;
}

export class DraftWorker {
  private client: SupabaseClient;
  private queue: DraftPgmqAdapter;
  private orchestrator: DraftOrchestrator;
  private pollIntervalMs: number;
  private visibilityTimeoutSeconds: number;

  constructor(
    client: SupabaseClient,
    orchestrator: DraftOrchestrator,
    config: DraftWorkerConfig
  ) {
    this.client = client;
    this.queue = new DraftPgmqAdapter(client);
    this.orchestrator = orchestrator;
    this.pollIntervalMs = config.pollIntervalMs;
    this.visibilityTimeoutSeconds = config.visibilityTimeoutSeconds;
  }

  /**
   * Main poll loop. Runs until the abort signal fires.
   */
  async run(signal: AbortSignal): Promise<void> {
    logger.info('Draft worker started', {});

    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error('Draft worker poll error', err as Error, {});
      }

      await this.sleep(this.pollIntervalMs, signal);
    }

    logger.info('Draft worker shutting down', {});
  }

  /**
   * Process one batch of queue messages.
   */
  private async pollOnce(): Promise<void> {
    const jobs = await this.queue.readJobs(1, this.visibilityTimeoutSeconds);

    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      await this.processJob(job);
    }
  }

  /**
   * Process a single draft generation job.
   */
  private async processJob(job: {
    msgId: bigint;
    readCt: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const { msgId, readCt, payload } = job;

    // Extract metadata-only fields from payload
    const draftGenerationJobId = payload.draftGenerationJobId as string;
    const requestId = (payload.requestId as string | null) ?? undefined;

    if (!draftGenerationJobId) {
      // Malformed queue payload: archive immediately
      logger.error('Malformed queue payload: missing draftGenerationJobId', undefined, {
        queueMessageId: msgId.toString(),
      });
      await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INTERNAL_ERROR');
      return;
    }

    // Log only sanitized metadata
    logger.info('Processing draft job', {
      draftGenerationJobId,
      requestId,
      attempt: readCt,
    });

    try {
      // Step 1: Load job row from database
      const jobRow = await this.loadJob(draftGenerationJobId);
      if (!jobRow) {
        logger.error('Draft job not found in database', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INTERNAL_ERROR');
        return;
      }

      // Step 2: Verify feature flag
      const flagEnabled = await this.checkFeatureFlag(jobRow.organization_id);
      if (!flagEnabled) {
        logger.info('Feature flag disabled, skipping draft job', {
          draftGenerationJobId,
          requestId,
        });
        await this.skipJob(draftGenerationJobId, msgId, 'FEATURE_DISABLED');
        return;
      }

      // Step 3: Load source message
      const sourceText = await this.loadSourceMessage(jobRow.source_message_id, jobRow.organization_id);
      if (!sourceText) {
        logger.error('Source message not found', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_REQUEST');
        return;
      }

      // Step 4: Load ai_draft_config
      const config = await this.loadDraftConfig(jobRow.business_profile_id, jobRow.organization_id);
      if (!config) {
        logger.error('Draft config not found', undefined, {
          draftGenerationJobId,
        });
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_INVALID_CONFIG');
        return;
      }

      // Step 5: Reserve quota
      const reservation = await this.reserveQuota(draftGenerationJobId);
      if (reservation.status === 'DENIED') {
        logger.info('Quota denied, skipping draft job', {
          draftGenerationJobId,
          requestId,
          reason: reservation.reason,
        });
        // Quota denial is an entitlement outcome, not a provider failure.
        // Terminate through the skip/denial path.
        await this.skipJob(draftGenerationJobId, msgId, 'QUOTA_DENIED');
        return;
      }

      // Step 6: Call orchestrator
      const draftRequest: DraftRequest = {
        sourceMessageText: sourceText,
        config,
        organizationId: jobRow.organization_id,
        requestId: requestId || draftGenerationJobId,
      };

      const result = await this.orchestrator.generateDraft(draftRequest);

      if (result.success) {
        // Step 7: Store draft
        await this.storeDraft(
          draftGenerationJobId,
          jobRow.business_profile_id,
          jobRow.conversation_id,
          jobRow.source_message_id,
          result.result.text,
          result.result.provider,
          result.result.model
        );

        // Step 8: Delete queue message
        await this.queue.deleteJob(msgId);

        logger.info('Draft generated successfully', {
          draftGenerationJobId,
          requestId,
          provider: result.result.provider,
          model: result.result.model,
          latencyMs: result.result.latencyMs,
          attempt: readCt,
        });
      } else {
        // Provider failure
        await this.handleProviderFailure(
          msgId,
          draftGenerationJobId,
          requestId,
          readCt,
          result.error.category
        );
      }
    } catch (err) {
      // Unexpected error: treat as transient if readCt < 3, else archive
      logger.error('Draft job processing error', err as Error, {
        draftGenerationJobId,
        requestId,
        attempt: readCt,
      });

      if (readCt < 3) {
        const delay = readCt === 1 ? RETRY_DELAY_1 : RETRY_DELAY_2;
        await this.queue.setVisibility(msgId, delay);
      } else {
        await this.archiveFailed(msgId, draftGenerationJobId, 'DRAFT_EXHAUSTED_RETRIES');
      }
    }
  }

  /**
   * Handle a provider failure: retry or archive based on attempt count.
   *
   * Per amendment #7: archive immediately after the third provider failure.
   * read_ct = 1 → visibility delay 5s
   * read_ct = 2 → visibility delay 15s
   * read_ct = 3 → archive immediately with DRAFT_EXHAUSTED_RETRIES
   */
  private async handleProviderFailure(
    msgId: bigint,
    draftGenerationJobId: string,
    requestId: string | undefined,
    readCt: number,
    errorCategory: ProviderErrorCategory
  ): Promise<void> {
    const dbErrorCode = mapProviderErrorToDbCode(errorCategory);

    logger.info('Provider failure', {
      draftGenerationJobId,
      requestId,
      attempt: readCt,
      errorCategory,
      dbErrorCode,
    });

    // Determine if this is a transient (fallback-eligible) or permanent failure.
    // Transient failures retry via PGMQ visibility timeout.
    // Permanent failures (fallback-prohibited) archive immediately.
    const isTransient =
      errorCategory === 'NETWORK_FAILURE' ||
      errorCategory === 'TIMEOUT' ||
      errorCategory === 'HTTP_408' ||
      errorCategory === 'HTTP_429' ||
      errorCategory === 'HTTP_5XX';

    if (isTransient && readCt < 3) {
      // Transient failure, attempts remaining: retry via visibility timeout
      const delay = readCt === 1 ? RETRY_DELAY_1 : RETRY_DELAY_2;
      await this.queue.setVisibility(msgId, delay);
    } else {
      // Permanent failure OR third transient failure: archive immediately
      const archiveCode = isTransient ? 'DRAFT_EXHAUSTED_RETRIES' as DraftErrorCode : dbErrorCode;
      await this.archiveFailed(msgId, draftGenerationJobId, archiveCode);
    }
  }

  // --- Database helper methods ---

  private async loadJob(jobId: string): Promise<{
    organization_id: string;
    conversation_id: string;
    source_message_id: string;
    business_profile_id: string;
  } | null> {
    const { data, error } = await this.client
      .from('draft_generation_jobs')
      .select('organization_id, conversation_id, source_message_id, business_profile_id')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      return null;
    }
    return data;
  }

  private async checkFeatureFlag(organizationId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('is_feature_enabled', {
      p_organization_id: organizationId,
      p_flag_key: 'ai_draft_generation',
    });

    if (error || data === null) {
      return false;
    }
    return data as boolean;
  }

  private async loadSourceMessage(messageId: string, organizationId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('body')
      .eq('id', messageId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) {
      return null;
    }
    return data.body;
  }

  private async loadDraftConfig(businessProfileId: string, organizationId: string): Promise<DraftConfig | null> {
    const { data, error } = await this.client
      .from('ai_draft_configs')
      .select('business_instructions, personality, response_rules, tone, max_draft_length')
      .eq('business_profile_id', businessProfileId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) {
      return null;
    }
    return {
      businessInstructions: data.business_instructions,
      personality: data.personality,
      responseRules: data.response_rules,
      tone: data.tone,
      maxDraftLength: data.max_draft_length,
    };
  }

  private async reserveQuota(jobId: string): Promise<{ status: string; reason: string | null }> {
    const { data, error } = await this.client.rpc('reserve_draft_usage', {
      p_draft_generation_job_id: jobId,
    });

    if (error) {
      return { status: 'DENIED', reason: 'RPC_ERROR' };
    }

    const result = data as { status: string; reason: string | null };
    return { status: result.status, reason: result.reason };
  }

  private async storeDraft(
    jobId: string,
    businessProfileId: string,
    conversationId: string,
    sourceMessageId: string,
    body: string,
    provider: string,
    model: string
  ): Promise<void> {
    const { error } = await this.client.rpc('store_draft', {
      p_draft_generation_job_id: jobId,
      p_business_profile_id: businessProfileId,
      p_conversation_id: conversationId,
      p_source_message_id: sourceMessageId,
      p_body: body,
      p_provider: provider,
      p_model: model,
    });

    if (error) {
      throw new Error(`store_draft RPC failed: ${error.code || 'UNKNOWN'}`);
    }
  }

  private async archiveFailed(msgId: bigint, jobId: string, errorCode: DraftErrorCode): Promise<void> {
    const { error } = await this.client.rpc('archive_draft_failed_job', {
      p_msg_id: msgId.toString(),
      p_draft_generation_job_id: jobId,
      p_error_code: errorCode,
    });

    if (error) {
      logger.error('Failed to archive draft job', new Error(error.code || 'UNKNOWN'), {
        draftGenerationJobId: jobId,
        queueMessageId: msgId.toString(),
      });
    }
  }

  private async skipJob(jobId: string, msgId: bigint, reason: string): Promise<void> {
    const { error } = await this.client.rpc('skip_draft_job', {
      p_draft_generation_job_id: jobId,
      p_msg_id: msgId.toString(),
      p_skip_reason: reason,
    });

    if (error) {
      logger.error('Failed to skip draft job', new Error(error.code || 'UNKNOWN'), {
        draftGenerationJobId: jobId,
      });
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}