export type JobType =
  | 'whatsapp.process_message'
  | 'appointment.send_reminder'
  | 'invoice.generate_pdf'
  | 'crm.sync_contact'
  | 'ai.process_transcript'
  | 'ai.generate_image'
  | 'ai.generate_video';

export interface BaseJobPayload {
  organizationId: string;
  userId?: string;
  requestId?: string;
  timestamp: string;
}

/**
 * Minimal queue payload for whatsapp_inbound jobs.
 * Contains ONLY: webhookEventId, requestId, timestamp.
 * Worker derives org and connection context from the trusted database receipt.
 */
export interface WhatsAppInboundPayload {
  webhookEventId: string;
  requestId: string | null;
  timestamp: string;
}

export interface JobDefinition<TPayload extends BaseJobPayload = BaseJobPayload> {
  id: string;
  type: JobType;
  payload: TPayload;
  attempts: number;
  maxAttempts: number;
  created_at: string;
}

export interface JobHandler<TPayload extends BaseJobPayload = BaseJobPayload> {
  jobType: JobType;
  execute(payload: TPayload): Promise<{ success: boolean; result?: unknown; error?: string }>;
}

export interface JobQueueAdapter {
  enqueue<TPayload extends BaseJobPayload>(
    type: JobType,
    payload: TPayload,
    options?: { delayMs?: number; maxAttempts?: number }
  ): Promise<{ jobId: string }>;
}

export class InMemoryJobQueue implements JobQueueAdapter {
  private handlers: Map<JobType, JobHandler> = new Map();

  public registerHandler(handler: JobHandler): void {
    this.handlers.set(handler.jobType, handler);
  }

  public async enqueue<TPayload extends BaseJobPayload>(
    type: JobType,
    payload: TPayload,
    options: { delayMs?: number; maxAttempts?: number } = {}
  ): Promise<{ jobId: string }> {
    const jobId = `job-${type}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    
    // Asynchronous execution without blocking main request loop
    setTimeout(async () => {
      const handler = this.handlers.get(type);
      if (handler) {
        try {
          await handler.execute(payload);
        } catch (err) {
          console.error(`Job [${jobId}] failed:`, err);
        }
      }
    }, options.delayMs || 0);

    return { jobId };
  }
}

export const jobQueue = new InMemoryJobQueue();
