-- ===========================================================================
-- The transcript ingest path
--
-- Migration: 20260903000008_transcript_ingest.sql
--
-- 20260903000004 shipped the Gladia adapter and the `voice_transcription` flag
-- and said what was blocking the wiring:
--
--     "`public.messages` has no column for what kind of message it was --
--      `message_kind` exists only on `inbound_message_staging` and is
--      discarded when that row is deleted. So today an audio message becomes a
--      row with `body = NULL` and nothing recording that it was ever a voice
--      note -- there is nowhere to put a transcript, and no way to mark one as
--      machine-transcribed."
--
-- There was a second gap underneath that one, found while building this: the
-- webhook stores only `payload_sha256`, never the payload, and
-- `ingest_whatsapp_message_event` takes no media reference at all. So even
-- with somewhere to PUT a transcript there was nowhere to fetch the audio
-- FROM. Both are closed here.
--
-- ---------------------------------------------------------------------------
-- 1. A TRANSCRIPT MUST BE DISTINGUISHABLE FROM WHAT A CUSTOMER TYPED
-- ---------------------------------------------------------------------------
--
-- Permanently, and at the row level. A reviewer approving a draft written from
-- a mis-transcribed voice note needs to see that is what happened -- the same
-- reason this system has never had a Send button.
--
-- So `body_source` is not decoration and not derivable: 'customer' means a
-- person wrote those words, 'machine_transcript' means a provider guessed at
-- them. A column that is sometimes NULL and read as "probably typed" would
-- defeat the purpose, which is why it is NULL exactly when `body` is, and
-- never otherwise.
--
-- ---------------------------------------------------------------------------
-- 2. WHAT THE BACKFILL CAN AND CANNOT KNOW
-- ---------------------------------------------------------------------------
--
-- `body_source` backfills EXACTLY. Nothing has ever transcribed anything, so
-- every existing non-NULL body is words a customer typed. That is a fact about
-- the system's history, not an assumption about the data.
--
-- `kind` backfills to NOTHING, and stays NULL on every pre-existing row. The
-- staging rows that knew it were deleted on processing, and `webhook_events`
-- kept a hash rather than a payload. Inferring 'text' from a non-NULL body
-- would be a guess -- a document message can carry a caption -- and a guessed
-- column is worse than an absent one because it reads as fact. NULL here means
-- "recorded before this migration", which is true and checkable.
--
-- ---------------------------------------------------------------------------
-- 3. THE IDEMPOTENCY KEY IS NOT TOUCHED
-- ---------------------------------------------------------------------------
--
-- `computeCanonicalHash` in the web app hashes a versioned array tagged
-- 'whatsapp-event-v1' and is the deduplication key for redelivered webhooks.
-- Adding the media reference to it would change the hash of every message,
-- so a redelivery that straddled the deploy would hash differently, miss the
-- duplicate check, and land twice.
--
-- The media reference therefore travels ALONGSIDE the hash and never inside
-- it. It adds no deduplication value anyway -- it is a property of the same
-- message the id already identifies. `whatsapp-normalizer.test.ts` asserts the
-- hash is unchanged, which makes this a rule rather than an intention.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- messages: what kind it was, where the body came from, where the media is
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS body_source TEXT,
  ADD COLUMN IF NOT EXISTS media_reference TEXT,
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_kind_supported
  CHECK (kind IS NULL OR kind IN
    ('text', 'image', 'video', 'audio', 'document', 'template'));

ALTER TABLE public.messages
  ADD CONSTRAINT messages_body_source_supported
  CHECK (body_source IS NULL OR body_source IN ('customer', 'machine_transcript'));

-- Exact, not assumed: nothing has ever transcribed anything, so every body
-- that exists today is words a customer typed.
UPDATE public.messages
SET body_source = 'customer'
WHERE body IS NOT NULL AND body_source IS NULL;

-- Added AFTER the backfill, because it would reject every existing row before
-- it. A body with no source would be text of unknown provenance, which is the
-- one thing a reviewer must never be shown.
ALTER TABLE public.messages
  ADD CONSTRAINT messages_body_source_with_body
  CHECK ((body IS NULL) = (body_source IS NULL));

COMMENT ON COLUMN public.messages.body_source IS
  'Who produced these words: ''customer'' typed them, ''machine_transcript'' '
  'means a provider guessed at them. NULL exactly when body is NULL.';
COMMENT ON COLUMN public.messages.kind IS
  'The provider''s message type. NULL on rows recorded before 20260903000008, '
  'because staging held it and was deleted -- inferring it would be a guess.';

-- ---------------------------------------------------------------------------
-- staging carries the media reference through
-- ---------------------------------------------------------------------------

ALTER TABLE public.inbound_message_staging
  ADD COLUMN IF NOT EXISTS media_reference TEXT,
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

-- ---------------------------------------------------------------------------
-- transcription jobs
-- ---------------------------------------------------------------------------
--
-- Deliberately shaped like `draft_generation_jobs` rather than cleverer. The
-- draft worker's lifecycle -- queued/processing/completed/skipped/dead_lettered,
-- an attempts counter, a pgmq message id, an error code -- is the shape the
-- operational tooling, the dead-letter path and the runbooks already
-- understand. A second job table with a different vocabulary would be a second
-- thing to learn for no gain.
--
-- `provider_job_reference` is the one addition, and it is the important one:
-- Gladia bills on submission, so a worker that loses the provider's job id and
-- resubmits pays twice for one voice note. The adapter's `onSubmitted` hook
-- exists to write it here before any waiting.
CREATE TABLE IF NOT EXISTS public.transcription_jobs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  source_message_id UUID NOT NULL,

  media_reference TEXT NOT NULL,
  media_mime_type TEXT,

  -- Written the moment the provider accepts the job, before any polling. The
  -- handle that makes a timeout resumable instead of billable twice.
  provider_job_reference TEXT,

  -- What language the provider says it heard. Gladia detects one whether or
  -- not a hint was given, and the draft path is about to write a reply in some
  -- language: a Spanish voice note answered in English is a visible failure
  -- that nobody can diagnose after the fact if the detection was discarded.
  -- Nullable because a provider may report none, and because an empty
  -- transcript has no language.
  language_code TEXT,

  pgmq_msg_id BIGINT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'skipped', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  skip_reason TEXT,
  error_code TEXT,
  provider TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  -- One transcription per message. A voice note transcribed twice is billed
  -- twice and can produce two different bodies for one message.
  CONSTRAINT transcription_jobs_one_per_message UNIQUE (source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status
  ON public.transcription_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_org
  ON public.transcription_jobs (organization_id);

ALTER TABLE public.transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.transcription_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transcription_jobs TO service_role;

CREATE TRIGGER trigger_transcription_jobs_updated_at
  BEFORE UPDATE ON public.transcription_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

SELECT pgmq.create('transcription');

-- ---------------------------------------------------------------------------
-- Ingest carries the media reference
-- ---------------------------------------------------------------------------

-- DROP FIRST, and this is not tidiness.
--
-- `CREATE OR REPLACE FUNCTION` with two ADDED parameters does not replace
-- anything: PostgreSQL keys functions by argument types, so it creates a
-- SECOND overload and leaves the 11-argument original in place. Every existing
-- 11-argument call then fails with "function ... is not unique", because the
-- defaults make both candidates match.
--
-- That is exactly what happened on the first run of this migration: fourteen
-- pgTAP suites failed at once, none of them for the reason the diff suggested.
-- The old signature has to go explicitly for this to be a replacement rather
-- than an ambiguity.
DROP FUNCTION IF EXISTS public.ingest_whatsapp_message_event(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT);

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
  p_request_id TEXT,
  -- Optional and defaulted so that every existing caller keeps working: the
  -- webhook route gains these in the same change, but a signature that broke
  -- callers would make this migration undeployable without a simultaneous web
  -- deploy, and the two do not ship atomically.
  p_media_reference TEXT DEFAULT NULL,
  p_media_mime_type TEXT DEFAULT NULL
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
  v_send_result BIGINT;
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
    message_kind, body_text, provider_timestamp,
    media_reference, media_mime_type
  )
  VALUES (
    v_webhook_event_id, p_provider_message_id, p_contact_identifier,
    p_message_kind, p_body_text, p_provider_timestamp,
    p_media_reference, p_media_mime_type
  );

  -- Send pgmq job with minimal payload
  -- pgmq.send(queue_name text, msg jsonb, delay integer) -> setof bigint
  -- Use SELECT ... INTO to consume the setof bigint as a scalar
  SELECT pgmq.send(
    'whatsapp_inbound',
    jsonb_build_object(
      'webhookEventId', v_webhook_event_id,
      'requestId', p_request_id,
      'timestamp', pg_catalog.now()
    ),
    0
  )
  INTO v_send_result;

  IF v_send_result IS NULL THEN
    RAISE EXCEPTION 'QUEUE_SEND_FAILED' USING ERRCODE = '90005';
  END IF;

  RETURN QUERY SELECT TRUE, v_webhook_event_id;
END;
$$;
-- ---------------------------------------------------------------------------
-- Processing records what kind it was, and enqueues transcription for audio
-- ---------------------------------------------------------------------------

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
  v_transcription_enabled BOOLEAN;
  v_transcription_job_id UUID;
  v_transcription_msg_id BIGINT;
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
      direction, provider_message_id, body, status,
      kind, body_source, media_reference, media_mime_type
    )
    VALUES (
      v_conversation_id, v_event.organization_id, p_webhook_event_id,
      'inbound', v_staging.provider_message_id, v_staging.body_text, 'received',
      v_staging.message_kind,
      -- 'customer' only where there are words, and only because they came
      -- from the webhook. A transcript replaces this with
      -- 'machine_transcript' through complete_transcription_job, never here.
      CASE WHEN v_staging.body_text IS NOT NULL THEN 'customer' END,
      v_staging.media_reference, v_staging.media_mime_type
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

  -- =====================================================
  -- Transcription enqueue (20260903000008)
  --
  -- Mirrors the draft enqueue above and is deliberately SEPARATE from it: an
  -- audio message has no body, so the draft gate's
  -- `message_kind = 'text' AND body_text IS NOT NULL` condition already
  -- excludes it. A voice note becomes a draft only after a transcript exists,
  -- which is complete_transcription_job's job, not this one's.
  --
  -- Both flags are read, not one: `voice_transcription` gates the spend, and
  -- transcribing a voice note nobody will ever draft from is spending money to
  -- produce a row no reviewer sees. If drafting is off for this organization
  -- there is no reason to pay Gladia for it.
  -- =====================================================

  v_transcription_enabled := public.is_feature_enabled(
    v_event.organization_id, 'voice_transcription');

  IF v_transcription_enabled
     AND public.is_feature_enabled(v_event.organization_id, 'ai_draft_generation')
     AND v_staging.message_kind = 'audio'
     -- No media reference means nothing to fetch. Older webhook deliveries
     -- carry none, and a job pointing at nothing would dead-letter after
     -- burning its retries.
     AND v_staging.media_reference IS NOT NULL
     AND (SELECT status FROM public.conversations WHERE id = v_conversation_id) = 'open'
  THEN
    BEGIN
      INSERT INTO public.transcription_jobs (
        organization_id, conversation_id, source_message_id,
        media_reference, media_mime_type, status
      )
      VALUES (
        v_event.organization_id, v_conversation_id, v_message_id,
        v_staging.media_reference, v_staging.media_mime_type, 'queued'
      )
      RETURNING id INTO v_transcription_job_id;

      SELECT pgmq.send(
        'transcription',
        jsonb_build_object(
          'transcriptionJobId', v_transcription_job_id,
          'requestId', 'transcribe-' || v_message_id::text,
          'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        0
      ) INTO v_transcription_msg_id;

      UPDATE public.transcription_jobs
      SET pgmq_msg_id = v_transcription_msg_id
      WHERE id = v_transcription_job_id;
    EXCEPTION WHEN unique_violation THEN
      -- One transcription per message. A redelivered webhook that reached the
      -- same message must not enqueue a second billable job.
      NULL;
    END;
  END IF;

  RETURN QUERY SELECT TRUE, v_conversation_id, v_message_id, FALSE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Completing a transcription
-- ---------------------------------------------------------------------------
--
-- One RPC does three things that must happen together or not at all: write the
-- transcript onto the message, mark the job done, and hand the message to the
-- draft path. Split across three calls, a worker that died between them would
-- leave a message with a body nobody drafts from, or a draft job for a message
-- with no body.
--
-- THE EMPTY TRANSCRIPT. A silent voice note transcribes to nothing and is
-- billed anyway. The adapter reports that faithfully rather than throwing
-- (packages/ai-providers/src/gladia.ts), so the decision lands here: the job
-- completes, the message keeps a NULL body, and NO draft is enqueued. Writing
-- '' would produce a message whose body_source says 'machine_transcript' and
-- whose content says nothing, which reads to a reviewer as a customer who sent
-- an empty message. Skipping the draft is the same call the text path already
-- makes with `body_text IS NOT NULL`.
CREATE OR REPLACE FUNCTION private.complete_transcription_job(
  p_job_id UUID,
  p_transcript TEXT,
  p_provider TEXT,
  p_provider_job_reference TEXT DEFAULT NULL,
  p_language_code TEXT DEFAULT NULL
)
RETURNS TABLE (message_id UUID, draft_enqueued BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_job RECORD;
  v_business_profile_id UUID;
  v_draft_job_id UUID;
  v_pgmq_msg_id BIGINT;
  v_draft_enqueued BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_job
  FROM public.transcription_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_NOT_FOUND' USING ERRCODE = 'P3I01';
  END IF;

  -- Terminal jobs are not re-completable. A redelivered queue message must not
  -- overwrite a transcript a reviewer may already have acted on.
  IF v_job.status IN ('completed', 'skipped', 'dead_lettered') THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_ALREADY_TERMINAL' USING ERRCODE = 'P3I02';
  END IF;

  UPDATE public.transcription_jobs
  SET status = 'completed',
      provider = p_provider,
      provider_job_reference = COALESCE(p_provider_job_reference, provider_job_reference),
      language_code = COALESCE(p_language_code, language_code),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;

  IF p_transcript IS NOT NULL AND length(trim(p_transcript)) > 0 THEN
    UPDATE public.messages
    SET body = p_transcript,
        body_source = 'machine_transcript'
    WHERE id = v_job.source_message_id;

    -- Feed the existing draft path, under the same conditions it applies to a
    -- typed message: the flag, a business profile, and an open conversation.
    IF public.is_feature_enabled(v_job.organization_id, 'ai_draft_generation') THEN
      SELECT id INTO v_business_profile_id
      FROM public.business_profiles
      WHERE organization_id = v_job.organization_id
      LIMIT 1;

      IF v_business_profile_id IS NOT NULL
         AND (SELECT status FROM public.conversations WHERE id = v_job.conversation_id) = 'open'
      THEN
        INSERT INTO public.draft_generation_jobs (
          organization_id, conversation_id, source_message_id,
          business_profile_id, status
        )
        VALUES (
          v_job.organization_id, v_job.conversation_id, v_job.source_message_id,
          v_business_profile_id, 'queued'
        )
        RETURNING id INTO v_draft_job_id;

        SELECT pgmq.send(
          'draft_generation',
          jsonb_build_object(
            'draftGenerationJobId', v_draft_job_id,
            'requestId', 'draft-' || v_job.source_message_id::text,
            'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ),
          0
        ) INTO v_pgmq_msg_id;

        UPDATE public.draft_generation_jobs
        SET pgmq_msg_id = v_pgmq_msg_id
        WHERE id = v_draft_job_id;

        v_draft_enqueued := TRUE;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_job.source_message_id, v_draft_enqueued;
END;
$$;

COMMENT ON FUNCTION private.complete_transcription_job IS
  'Writes a transcript onto its message as machine-transcribed, completes the '
  'job, and enqueues a draft -- atomically, because a worker dying between '
  'those steps leaves either an undraftable body or a bodiless draft job. An '
  'empty transcript completes the job and enqueues nothing.';

-- Failure is separate, and does NOT touch the message. A failed transcription
-- leaves a voice note with no body, which is exactly what it was before the
-- attempt; writing an error string into `body` would put provider diagnostics
-- in front of a reviewer as though the customer had said them.
CREATE OR REPLACE FUNCTION private.fail_transcription_job(
  p_job_id UUID,
  p_error_code TEXT,
  p_dead_letter BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM public.transcription_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_NOT_FOUND' USING ERRCODE = 'P3I01';
  END IF;

  IF v_status IN ('completed', 'skipped', 'dead_lettered') THEN
    RAISE EXCEPTION 'TRANSCRIPTION_JOB_ALREADY_TERMINAL' USING ERRCODE = 'P3I02';
  END IF;

  UPDATE public.transcription_jobs
  SET status = CASE WHEN p_dead_letter THEN 'dead_lettered' ELSE 'queued' END,
      attempts = attempts + 1,
      error_code = p_error_code,
      updated_at = pg_catalog.now()
  WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.complete_transcription_job(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.complete_transcription_job(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION private.fail_transcription_job(UUID, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.fail_transcription_job(UUID, TEXT, BOOLEAN)
  TO service_role;

REVOKE ALL ON FUNCTION public.ingest_whatsapp_message_event(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_whatsapp_message_event(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  TO service_role;
