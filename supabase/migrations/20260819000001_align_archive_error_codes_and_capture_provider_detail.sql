-- Migration: 20260819000001_align_archive_error_codes_and_capture_provider_detail.sql
--
-- Fixes the defect found during the first end-to-end draft run (2026-08-19).
--
-- WHAT WENT WRONG
-- Langdock rejected `model: "auto"` with HTTP 400 invalid_request_error. The
-- worker classified that correctly as terminal and called
-- archive_draft_failed_job with 'DRAFT_INVALID_REQUEST'. But the RPC's own
-- allowlist accepted only five codes:
--     DRAFT_EXHAUSTED_RETRIES, DRAFT_PROVIDER_ERROR,
--     DRAFT_GENERATION_TIMEOUT, DRAFT_QUOTA_EXCEEDED, DRAFT_INTERNAL_ERROR
-- while the worker produces eight (see apps/worker/src/draft-rpc-error-codes.ts,
-- and the wider failed_jobs CHECK added in 20260805000014). So the archive was
-- rejected with P3B15 INVALID_DRAFT_FAILURE_CODE, the worker logged and moved
-- on, and the queue message was neither archived nor deleted. It was
-- redelivered until read_ct exceeded the limit, at which point
-- read_draft_generation_jobs dead-lettered it as DRAFT_EXHAUSTED_RETRIES.
--
-- Net effect: a terminal 400 presented as three exhausted retries, and the
-- provider's actual complaint ("Invalid model, available models are: ...") was
-- recorded nowhere. It could only be found by curling the API by hand.
--
-- THIS MIGRATION
-- 1. Aligns the archive allowlist with the codes the worker actually produces
--    (every one of which already satisfies the failed_jobs CHECK constraint).
-- 2. Adds failed_jobs.provider_error_detail so the provider's own error text is
--    captured on the dead-letter record.
--
-- The detail is sanitized and truncated before it ever reaches the database
-- (packages/ai-providers/src/errors.ts): only the provider's structured error
-- fields are extracted, credential-shaped substrings are redacted, and the
-- result is capped at 300 characters. It is not the raw response body, so it
-- cannot become a path for prompts or customer message text to leak into
-- storage. The 512-char CHECK below is a backstop against that cap drifting.

-- -----------------------------------------------------------------------------
-- 1. Capture column
-- -----------------------------------------------------------------------------

ALTER TABLE public.failed_jobs
  ADD COLUMN IF NOT EXISTS provider_error_detail TEXT;

ALTER TABLE public.failed_jobs
  DROP CONSTRAINT IF EXISTS failed_jobs_provider_error_detail_length;

ALTER TABLE public.failed_jobs
  ADD CONSTRAINT failed_jobs_provider_error_detail_length CHECK (
    provider_error_detail IS NULL OR char_length(provider_error_detail) <= 512
  );

COMMENT ON COLUMN public.failed_jobs.provider_error_detail IS
  'Sanitized, truncated description of the provider''s own error (never the raw response body, never credentials or customer content). Populated by the draft worker via archive_draft_failed_job.';

-- -----------------------------------------------------------------------------
-- 2. private.archive_draft_failed_job — extended allowlist + detail parameter
--
-- Dropped and recreated rather than CREATE OR REPLACE'd: adding a parameter
-- changes the signature, which would otherwise create a second overload and
-- leave the old three-argument version callable.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.archive_draft_failed_job(BIGINT, UUID, TEXT);
DROP FUNCTION IF EXISTS private.archive_draft_failed_job(BIGINT, UUID, TEXT);

CREATE FUNCTION private.archive_draft_failed_job(
  p_msg_id BIGINT,
  p_draft_generation_job_id UUID,
  p_error_code TEXT,
  p_provider_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing_id UUID;
  v_archive_result BOOLEAN;
  v_queue_name TEXT := 'draft_generation';
  v_job_type TEXT := 'DRAFT_GENERATION';
  v_release_result TEXT;
  v_job RECORD;
  v_derived_request_id TEXT;
  v_derived_attempts INTEGER;
  v_detail TEXT;
BEGIN
  -- Check for existing failed_jobs record (idempotent)
  SELECT id INTO v_existing_id
  FROM public.failed_jobs
  WHERE queue_name = v_queue_name AND pgmq_msg_id = p_msg_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;

  -- Lock and validate the job: must exist, must not be completed
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_JOB_NOT_FOUND' USING ERRCODE = 'P3B07';
  END IF;

  -- Cannot archive a completed job
  IF v_job.status = 'completed' THEN
    RAISE EXCEPTION 'DRAFT_ARCHIVE_STATE_ERROR' USING ERRCODE = 'P3B12';
  END IF;

  -- Cannot archive a skipped job
  IF v_job.status = 'skipped' THEN
    RAISE EXCEPTION 'DRAFT_ARCHIVE_STATE_ERROR' USING ERRCODE = 'P3B12';
  END IF;

  -- Verify supplied p_msg_id equals the job's stored pgmq_msg_id
  -- A NULL pgmq_msg_id means the job was never claimed by a worker
  IF v_job.pgmq_msg_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_DRAFT_ATTEMPTS' USING ERRCODE = 'P3B16';
  END IF;
  IF v_job.pgmq_msg_id <> p_msg_id THEN
    RAISE EXCEPTION 'DRAFT_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3B08';
  END IF;

  -- Verify queue is draft_generation (constant, but explicit for audit)
  IF v_queue_name <> 'draft_generation' THEN
    RAISE EXCEPTION 'DRAFT_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3B08';
  END IF;

  -- Verify job type/workflow is DRAFT_GENERATION
  IF v_job_type <> 'DRAFT_GENERATION' THEN
    RAISE EXCEPTION 'DRAFT_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3B08';
  END IF;

  -- Allowed dead-letter error codes.
  --
  -- Must remain a superset of DraftErrorCode in
  -- apps/worker/src/draft-rpc-error-codes.ts. The first five are the original
  -- set; the rest were added 2026-08-19 because the worker was already
  -- producing them and every archive using them was being rejected. All of
  -- them already satisfy the failed_jobs CHECK from 20260805000014.
  IF p_error_code IS NULL OR p_error_code NOT IN (
    'DRAFT_EXHAUSTED_RETRIES',
    'DRAFT_PROVIDER_ERROR',
    'DRAFT_GENERATION_TIMEOUT',
    'DRAFT_QUOTA_EXCEEDED',
    'DRAFT_INTERNAL_ERROR',
    'DRAFT_PROVIDER_AUTH_ERROR',
    'DRAFT_PROVIDER_CONFIG_ERROR',
    'DRAFT_MALFORMED_RESPONSE',
    'DRAFT_INVALID_REQUEST',
    'DRAFT_PROVIDER_EMPTY_OUTPUT',
    'DRAFT_PROVIDER_OUTPUT_TOO_LONG',
    'DRAFT_INVALID_CONFIG'
  ) THEN
    RAISE EXCEPTION 'INVALID_DRAFT_FAILURE_CODE' USING ERRCODE = 'P3B15';
  END IF;

  -- Backstop truncation. The application sanitizes and caps at 300 chars; this
  -- guarantees the CHECK can never be violated even if that cap changes.
  v_detail := NULLIF(pg_catalog.left(pg_catalog.btrim(p_provider_error_detail), 512), '');

  -- Derive request_id from stored database state
  v_derived_request_id := 'draft-' || v_job.source_message_id::text;

  -- Derive attempt count from stored database state
  v_derived_attempts := v_job.attempts;
  IF v_derived_attempts IS NULL OR v_derived_attempts < 1 THEN
    RAISE EXCEPTION 'INVALID_DRAFT_ATTEMPTS' USING ERRCODE = 'P3B16';
  END IF;

  -- Release the reservation if the job has one (consumed reservations are never released)
  v_release_result := private.release_draft_reservation_internal(p_draft_generation_job_id);

  -- Mark job as dead_lettered
  UPDATE public.draft_generation_jobs
  SET status = 'dead_lettered',
      error_code = p_error_code,
      updated_at = pg_catalog.now()
  WHERE id = p_draft_generation_job_id AND status NOT IN ('completed', 'skipped');

  -- Insert failed_jobs record and archive pgmq message atomically
  BEGIN
    INSERT INTO public.failed_jobs (
      webhook_event_id, job_type, request_id, error_code,
      attempts, queue_name, pgmq_msg_id, provider_error_detail
    )
    VALUES (
      NULL, v_job_type, v_derived_request_id, p_error_code,
      v_derived_attempts, v_queue_name, p_msg_id, v_detail
    );

    -- Archive the pgmq message
    v_archive_result := pgmq.archive(v_queue_name, p_msg_id);

    IF v_archive_result IS NULL OR v_archive_result = FALSE THEN
      RAISE EXCEPTION 'ARCHIVE_FAILED' USING ERRCODE = '90006';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;

  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION private.archive_draft_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.archive_draft_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. public wrapper
--
-- p_provider_error_detail defaults to NULL, so existing three-argument callers
-- keep working unchanged.
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.archive_draft_failed_job(
  p_msg_id BIGINT,
  p_draft_generation_job_id UUID,
  p_error_code TEXT,
  p_provider_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM private.archive_draft_failed_job(
    p_msg_id,
    p_draft_generation_job_id,
    p_error_code,
    p_provider_error_detail
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_draft_failed_job(BIGINT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_draft_failed_job(BIGINT, UUID, TEXT, TEXT)
  TO service_role;
