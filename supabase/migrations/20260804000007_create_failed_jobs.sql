-- Phase 3A: failed_jobs table (NARROW FIELDS ONLY)
-- Migration: 20260804000007_create_failed_jobs.sql

CREATE TABLE IF NOT EXISTS public.failed_jobs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  webhook_event_id UUID REFERENCES public.webhook_events(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  request_id TEXT
    CHECK (request_id IS NULL OR char_length(request_id) <= 128),
  error_code TEXT NOT NULL
    CHECK (
      error_code IN (
        'INVALID_QUEUE_PAYLOAD', 'RECEIPT_NOT_FOUND', 'STAGING_NOT_FOUND',
        'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND', 'DB_TRANSIENT'
      )
    ),
  attempts INT NOT NULL
    CHECK (attempts >= 1),
  queue_name TEXT NOT NULL,
  pgmq_msg_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Dedup: one failed_jobs record per queue message
ALTER TABLE public.failed_jobs
  ADD CONSTRAINT failed_jobs_queue_msg_unique
  UNIQUE (queue_name, pgmq_msg_id);

CREATE INDEX idx_failed_jobs_webhook_event_id ON public.failed_jobs(webhook_event_id);
CREATE INDEX idx_failed_jobs_error_code ON public.failed_jobs(error_code);

-- RLS: ENABLED + FORCE, NO authenticated-user policies. Service-role only.
ALTER TABLE public.failed_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.failed_jobs FORCE ROW LEVEL SECURITY;