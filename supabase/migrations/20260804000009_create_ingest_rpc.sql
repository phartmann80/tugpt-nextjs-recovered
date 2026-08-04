-- Phase 3A: Ingest WhatsApp message event RPC
-- Migration: 20260804000009_create_ingest_rpc.sql

CREATE OR REPLACE FUNCTION public.ingest_whatsapp_message_event(
  p_provider_connection_identifier TEXT,
  p_provider TEXT,
  p_provider_event_key TEXT,
  p_event_kind TEXT,
  p_payload_sha256 TEXT,
  p_provider_message_id TEXT,
  p_contact_identifier TEXT,
  p_message_kind TEXT,
  p_body_text TEXT,
  p_provider_timestamp TIMESTAMPTZ,
  p_request_id TEXT
)
RETURNS TABLE(is_new BOOLEAN, webhook_event_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_connection_id UUID;
  v_organization_id UUID;
  v_webhook_event_id UUID;
  v_existing_sha256 TEXT;
  v_send_result BOOLEAN;
BEGIN
  -- Resolve connection and org from the trusted database lookup
  SELECT id, organization_id
  INTO v_connection_id, v_organization_id
  FROM public.whatsapp_connections
  WHERE provider_phone_number_id = p_provider_connection_identifier
    AND status = 'active';

  IF v_connection_id IS NULL THEN
    RAISE EXCEPTION 'CONNECTION_NOT_FOUND' USING ERRCODE = '90003';
  END IF;

  -- Check for duplicate event key
  SELECT payload_sha256
  INTO v_existing_sha256
  FROM public.webhook_events
  WHERE provider = p_provider
    AND whatsapp_connection_id = v_connection_id
    AND provider_event_key = p_provider_event_key;

  IF v_existing_sha256 IS NOT NULL THEN
    -- Duplicate event key: compare canonical hash
    IF v_existing_sha256 = p_payload_sha256 THEN
      -- Same event, same content: idempotent success
      SELECT id INTO v_webhook_event_id
      FROM public.webhook_events
      WHERE provider = p_provider
        AND whatsapp_connection_id = v_connection_id
        AND provider_event_key = p_provider_event_key;

      RETURN QUERY SELECT FALSE, v_webhook_event_id;
      RETURN;
    ELSE
      -- Same key, different content: mismatch
      RAISE EXCEPTION 'EVENT_KEY_PAYLOAD_MISMATCH' USING ERRCODE = '90004';
    END IF;
  END IF;

  -- Insert metadata-only webhook_events receipt
  INSERT INTO public.webhook_events (
    organization_id, whatsapp_connection_id, provider,
    provider_event_key, event_kind, payload_sha256
  )
  VALUES (
    v_organization_id, v_connection_id, p_provider,
    p_provider_event_key, p_event_kind, p_payload_sha256
  )
  RETURNING id INTO v_webhook_event_id;

  -- Insert narrow staging data with typed columns
  INSERT INTO public.inbound_message_staging (
    webhook_event_id, provider_message_id, contact_identifier,
    message_kind, body_text, provider_timestamp
  )
  VALUES (
    v_webhook_event_id, p_provider_message_id, p_contact_identifier,
    p_message_kind, p_body_text, p_provider_timestamp
  );

  -- Send pgmq job with minimal payload
  v_send_result := pgmq.send(
    'whatsapp_inbound',
    jsonb_build_object(
      'webhookEventId', v_webhook_event_id,
      'requestId', p_request_id,
      'timestamp', pg_catalog.now()
    )
  );

  IF v_send_result IS NULL OR v_send_result = FALSE THEN
    RAISE EXCEPTION 'QUEUE_SEND_FAILED' USING ERRCODE = '90005';
  END IF;

  RETURN QUERY SELECT TRUE, v_webhook_event_id;
END;
$$;

-- Service-role only
REVOKE ALL ON FUNCTION public.ingest_whatsapp_message_event(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_whatsapp_message_event(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;