-- Phase 3A: Process inbound message RPC
-- Migration: 20260804000010_create_process_message_rpc.sql

CREATE OR REPLACE FUNCTION public.process_inbound_message(
  p_webhook_event_id UUID
)
RETURNS TABLE(success BOOLEAN, conversation_id UUID, message_id UUID, already_processed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_event RECORD;
  v_staging RECORD;
  v_conversation_id UUID;
  v_message_id UUID;
  v_existing_message_id UUID;
BEGIN
  -- Load receipt by webhookEventId with row lock
  SELECT * INTO v_event
  FROM public.webhook_events
  WHERE id = p_webhook_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND';
  END IF;

  -- Check if already processed
  IF v_event.status = 'processed' THEN
    -- Check for existing message
    SELECT id INTO v_message_id
    FROM public.messages
    WHERE webhook_event_id = p_webhook_event_id;

    RETURN QUERY SELECT TRUE, NULL::uuid, v_message_id, TRUE;
    RETURN;
  END IF;

  -- Load staging data
  SELECT * INTO v_staging
  FROM public.inbound_message_staging
  WHERE webhook_event_id = p_webhook_event_id;

  IF NOT FOUND THEN
    -- Staging not found for unprocessed receipt: non-retryable
    RAISE EXCEPTION 'STAGING_NOT_FOUND';
  END IF;

  -- Find or create conversation (preserve existing status)
  SELECT id INTO v_conversation_id
  FROM public.conversations
  WHERE organization_id = v_event.organization_id
    AND whatsapp_connection_id = v_event.whatsapp_connection_id
    AND contact_phone = v_staging.contact_identifier;

  IF v_conversation_id IS NULL THEN
    INSERT INTO public.conversations (
      organization_id, whatsapp_connection_id, contact_phone,
      status, last_message_at
    )
    VALUES (
      v_event.organization_id, v_event.whatsapp_connection_id,
      v_staging.contact_identifier, 'open', v_staging.provider_timestamp
    )
    RETURNING id INTO v_conversation_id;
  ELSE
    -- Update last_message_at without changing status
    UPDATE public.conversations
    SET last_message_at = v_staging.provider_timestamp,
        updated_at = pg_catalog.now()
    WHERE id = v_conversation_id;
  END IF;

  -- Insert message (idempotent via UNIQUE(webhook_event_id))
  BEGIN
    INSERT INTO public.messages (
      conversation_id, organization_id, webhook_event_id,
      direction, provider_message_id, body, status
    )
    VALUES (
      v_conversation_id, v_event.organization_id, p_webhook_event_id,
      'inbound', v_staging.provider_message_id, v_staging.body_text, 'received'
    )
    RETURNING id INTO v_message_id;
  EXCEPTION WHEN unique_violation THEN
    -- Message already exists: idempotent success
    SELECT id INTO v_message_id
    FROM public.messages
    WHERE webhook_event_id = p_webhook_event_id;
  END;

  -- Mark receipt as processed
  UPDATE public.webhook_events
  SET status = 'processed',
      processed_at = pg_catalog.now(),
      attempt_count = GREATEST(attempt_count, 1),
      last_error_code = NULL
  WHERE id = p_webhook_event_id;

  -- Delete staging data
  DELETE FROM public.inbound_message_staging
  WHERE webhook_event_id = p_webhook_event_id;

  RETURN QUERY SELECT TRUE, v_conversation_id, v_message_id, FALSE;
END;
$$;

-- Service-role only
REVOKE ALL ON FUNCTION public.process_inbound_message(UUID)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.process_inbound_message(UUID)
TO service_role;