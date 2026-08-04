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
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT';
  END IF;

  RETURN QUERY
  SELECT msg_id, read_ct, payload, enqueued_at, vt
  FROM pgmq.read('whatsapp_inbound', v_limit, 30);
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
  v_result BOOLEAN;
  v_vt TIMESTAMPTZ;
BEGIN
  -- Validate visibility timeout (reject, do not clamp)
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT';
  END IF;

  v_vt := pg_catalog.now() + (p_visibility_timeout_seconds || ' seconds')::INTERVAL;
  v_result := pgmq.set_vt('whatsapp_inbound', p_msg_id, v_vt);
  RETURN COALESCE(v_result, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.set_whatsapp_inbound_visibility(BIGINT, INT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_whatsapp_inbound_visibility(BIGINT, INT)
TO service_role;