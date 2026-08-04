-- Phase 3A: Record inbound processing failure RPC
-- Migration: 20260804000012_create_record_failure_rpc.sql

CREATE OR REPLACE FUNCTION public.record_inbound_processing_failure(
  p_webhook_event_id UUID,
  p_error_code TEXT,
  p_attempt_count INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current_status TEXT;
  v_current_attempt INT;
BEGIN
  -- Validate error code is in the processing allowlist
  IF p_error_code NOT IN ('DB_TRANSIENT', 'STAGING_NOT_FOUND', 'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND') THEN
    RAISE EXCEPTION 'Invalid error code for record_inbound_processing_failure: %', p_error_code;
  END IF;

  -- Get current state
  SELECT status, attempt_count
  INTO v_current_status, v_current_attempt
  FROM public.webhook_events
  WHERE id = p_webhook_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND' USING ERRCODE = '90001';
  END IF;

  -- Must not overwrite processed or failed with received
  IF v_current_status IN ('processed', 'failed') THEN
    RETURN FALSE;
  END IF;

  -- Update attempt_count (monotonic: GREATEST) and last_error_code
  -- Status stays 'received' (below final attempt)
  UPDATE public.webhook_events
  SET attempt_count = GREATEST(v_current_attempt, p_attempt_count),
      last_error_code = p_error_code
  WHERE id = p_webhook_event_id
    AND status = 'received';

  RETURN TRUE;
END;
$$;

-- Service-role only
REVOKE ALL ON FUNCTION public.record_inbound_processing_failure(
  UUID, TEXT, INT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_inbound_processing_failure(
  UUID, TEXT, INT
) TO service_role;