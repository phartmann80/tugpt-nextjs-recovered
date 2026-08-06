-- Phase 3B: Extend process_inbound_message to include atomic draft enqueue
-- Migration: 20260805000017_extend_process_inbound_message.sql
-- This is the LAST migration because it depends on all tables, helpers, queue objects.
--
-- IMPORTANT: The Phase 3A signature process_inbound_message(UUID) and its
-- 4-column return type (success, conversation_id, message_id, already_processed)
-- are PRESERVED. We use CREATE OR REPLACE FUNCTION to extend the internal
-- transaction without changing the external interface. Existing Phase 3A
-- callers remain compatible.

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
  v_business_profile_id UUID;
  v_draft_job_id UUID;
  v_pgmq_msg_id BIGINT;
  v_feature_enabled BOOLEAN;
  v_reserve_status TEXT;
  v_reserve_reason TEXT;
BEGIN
  -- Load receipt by webhookEventId with row lock
  SELECT * INTO v_event
  FROM public.webhook_events
  WHERE id = p_webhook_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND' USING ERRCODE = '90001';
  END IF;

  -- Check if already processed
  IF v_event.status = 'processed' THEN
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
    RAISE EXCEPTION 'STAGING_NOT_FOUND' USING ERRCODE = '90002';
  END IF;

  -- Validate staging data integrity
  IF v_staging.contact_identifier IS NULL OR v_staging.provider_message_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_STAGING' USING ERRCODE = '90008';
  END IF;

  -- Validate message kind is supported
  IF v_staging.message_kind NOT IN ('text', 'image', 'video', 'audio', 'document', 'template') THEN
    RAISE EXCEPTION 'UNSUPPORTED_MESSAGE_KIND' USING ERRCODE = '90009';
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

  -- =====================================================
  -- Phase 3B: Atomic draft enqueue (internal extension)
  -- The return type is unchanged: existing callers see
  -- (TRUE, conversation_id, message_id, FALSE) as before.
  -- Draft job creation is a side effect, not a return value.
  -- =====================================================

  -- Check if AI draft generation feature is enabled
  v_feature_enabled := public.is_feature_enabled(v_event.organization_id, 'ai_draft_generation');

  IF v_feature_enabled THEN
    -- Resolve business profile for this org
    SELECT id INTO v_business_profile_id
    FROM public.business_profiles
    WHERE organization_id = v_event.organization_id
    LIMIT 1;

    IF v_business_profile_id IS NOT NULL THEN
      -- Check conversation status (only enqueue for open conversations)
      IF (SELECT status FROM public.conversations WHERE id = v_conversation_id) = 'open' THEN
        -- Check message kind (only text messages generate drafts)
        IF v_staging.message_kind = 'text' AND v_staging.body_text IS NOT NULL THEN
          -- Create draft generation job
          INSERT INTO public.draft_generation_jobs (
            organization_id, conversation_id, source_message_id,
            business_profile_id, status
          )
          VALUES (
            v_event.organization_id, v_conversation_id, v_message_id,
            v_business_profile_id, 'queued'
          )
          RETURNING id INTO v_draft_job_id;

          -- Enqueue PGMQ message with approved 3-field metadata-only payload
          SELECT pgmq.send(
            'draft_generation',
            jsonb_build_object(
              'draftGenerationJobId', v_draft_job_id,
              'requestId', 'draft-' || v_message_id::text,
              'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ),
            0
          ) INTO v_pgmq_msg_id;

          -- Update job with pgmq_msg_id
          UPDATE public.draft_generation_jobs
          SET pgmq_msg_id = v_pgmq_msg_id
          WHERE id = v_draft_job_id;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT TRUE, v_conversation_id, v_message_id, FALSE;
END;
$$;

-- Service-role only (same as Phase 3A)
REVOKE ALL ON FUNCTION public.process_inbound_message(UUID)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.process_inbound_message(UUID)
TO service_role;