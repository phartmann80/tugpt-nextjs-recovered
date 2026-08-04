-- Phase 3A: Queue wrapper RPCs
-- Migration: 20260804000013_create_queue_wrapper_rpcs.sql

-- read_whatsapp_inbound_jobs: read messages from the whatsapp_inbound queue
CREATE OR REPLACE FUNCTION public.read_whatsapp_inbound_jobs(
  p_limit INT DEFAULT 1
)
RETURNS TABLE(
  msg_id BIGINT,
  read_ct INT,
  payload JSONB,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit INT := p_limit;
BEGIN
  -- Validate limit (reject, do not clamp)
  IF v_limit < 1 OR v_limit > 10 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  -- pgmq.read(queue_name text, vt integer, qty integer) -> message_record rows
  -- message_record columns: msg_id, read_ct, enqueued_at, vt, message (jsonb)
  -- We alias message -> payload in the output to match the RETURNS TABLE signature
  RETURN QUERY
  SELECT r.msg_id, r.read_ct, r.message AS payload, r.enqueued_at, r.vt
  FROM pgmq.read('whatsapp_inbound', 30, v_limit) AS r;
END;
$$;

REVOKE ALL ON FUNCTION public.read_whatsapp_inbound_jobs(INT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_whatsapp_inbound_jobs(INT)
TO service_role;

-- delete_whatsapp_inbound_job: delete a message from the queue
CREATE OR REPLACE FUNCTION public.delete_whatsapp_inbound_job(
  p_msg_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result BOOLEAN;
BEGIN
  -- pgmq.delete(queue_name text, msg_id bigint) -> boolean
  v_result := pgmq.delete('whatsapp_inbound', p_msg_id);
  RETURN COALESCE(v_result, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_whatsapp_inbound_job(BIGINT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_whatsapp_inbound_job(BIGINT)
TO service_role;

-- set_whatsapp_inbound_visibility: extend visibility timeout for a message
CREATE OR REPLACE FUNCTION public.set_whatsapp_inbound_visibility(
  p_msg_id BIGINT,
  p_visibility_timeout_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_record pgmq.message_record;
BEGIN
  -- Validate visibility timeout (reject, do not clamp)
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  -- pgmq.set_vt(queue_name text, msg_id bigint, vt_offset integer) -> pgmq.message_record
  -- The native function returns a message record, not a boolean.
  -- We convert the presence of the returned record into a boolean result.
  v_record := pgmq.set_vt('whatsapp_inbound', p_msg_id, p_visibility_timeout_seconds);
  RETURN v_record IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.set_whatsapp_inbound_visibility(BIGINT, INT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_whatsapp_inbound_visibility(BIGINT, INT)
TO service_role;