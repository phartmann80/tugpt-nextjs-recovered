-- Phase 3A: Dead-letter / archive_failed_job RPC
-- Migration: 20260804000011_create_dead_letter_rpc.sql

CREATE OR REPLACE FUNCTION public.archive_failed_job(
  p_msg_id BIGINT,
  p_request_id TEXT,
  p_error_code TEXT,
  p_attempts INTEGER,
  p_webhook_event_id UUID DEFAULT NULL
)
RETURNS TABLE(archived BOOLEAN, already_archived BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing_id UUID;
  v_archive_result BOOLEAN;
  v_queue_name TEXT := 'whatsapp_inbound';
  v_job_type TEXT := 'whatsapp_inbound_message';
BEGIN
  -- Validate error_code / webhook_event_id combination
  IF p_webhook_event_id IS NULL THEN
    -- NULL webhook_event_id: only INVALID_QUEUE_PAYLOAD or RECEIPT_NOT_FOUND allowed
    IF p_error_code NOT IN ('INVALID_QUEUE_PAYLOAD', 'RECEIPT_NOT_FOUND') THEN
      RAISE EXCEPTION 'Invalid error code for NULL webhook_event_id: %', p_error_code;
    END IF;
  ELSE
    -- Non-NULL webhook_event_id: verify receipt exists and error code is valid
    IF p_error_code NOT IN ('STAGING_NOT_FOUND', 'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND', 'DB_TRANSIENT') THEN
      RAISE EXCEPTION 'Invalid error code for non-NULL webhook_event_id: %', p_error_code;
    END IF;

    -- Verify the receipt exists
    PERFORM 1 FROM public.webhook_events WHERE id = p_webhook_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECEIPT_NOT_FOUND' USING ERRCODE = '90001';
    END IF;
  END IF;

  -- Check for existing failed_jobs record (idempotent)
  SELECT id INTO v_existing_id
  FROM public.failed_jobs
  WHERE queue_name = v_queue_name AND pgmq_msg_id = p_msg_id;

  IF v_existing_id IS NOT NULL THEN
    -- Already archived: idempotent success
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;

  -- Insert failed_jobs record and archive pgmq message atomically
  BEGIN
    INSERT INTO public.failed_jobs (
      webhook_event_id, job_type, request_id, error_code,
      attempts, queue_name, pgmq_msg_id
    )
    VALUES (
      p_webhook_event_id, v_job_type, p_request_id, p_error_code,
      p_attempts, v_queue_name, p_msg_id
    );

    -- Archive the pgmq message
    v_archive_result := pgmq.archive(v_queue_name, p_msg_id);

    IF v_archive_result IS NULL OR v_archive_result = FALSE THEN
      -- Archive failed: rollback the failed_jobs insert
      RAISE EXCEPTION 'ARCHIVE_FAILED' USING ERRCODE = '90006';
    END IF;

    -- Set receipt to failed if webhook_event_id is provided
    IF p_webhook_event_id IS NOT NULL THEN
      UPDATE public.webhook_events
      SET status = 'failed',
          last_error_code = p_error_code,
          attempt_count = GREATEST(attempt_count, p_attempts)
      WHERE id = p_webhook_event_id
        AND status = 'received';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Rollback everything on failure
    RAISE;
  END;

  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

-- Service-role only
REVOKE ALL ON FUNCTION public.archive_failed_job(
  BIGINT, TEXT, TEXT, INTEGER, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.archive_failed_job(
  BIGINT, TEXT, TEXT, INTEGER, UUID
) TO service_role;