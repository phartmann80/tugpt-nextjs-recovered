-- Phase 3B: Draft generation service-role RPCs and private helpers
-- Migration: 20260805000015_create_draft_generation_rpcs.sql

-- =============================================================================
-- PRIVATE SCHEMA HELPERS (not exposed through PostgREST)
-- All helpers: SECURITY DEFINER, SET search_path = pg_catalog, fully qualified refs
-- SECURITY: organization_id is derived from the locked job row, never caller-supplied.
-- =============================================================================

-- Grant service_role usage on private schema (already done in migration 001, but ensure)
GRANT USAGE ON SCHEMA private TO service_role;

-- -----------------------------------------------------------------------------
-- private.reserve_draft_usage: Reserve a quota slot for a draft generation job
-- Derives organization_id from the locked job row.
-- Returns: TABLE(status TEXT, reason TEXT)
--   status: 'NEWLY_RESERVED', 'ALREADY_RESERVED', 'ALREADY_CONSUMED',
--           'RESERVATION_RELEASED', 'DENIED'
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.reserve_draft_usage(
  p_draft_generation_job_id UUID,
  OUT status TEXT,
  OUT reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_reservation RECORD;
  v_quota_limit RECORD;
  v_usage RECORD;
  v_inserted_id UUID;
  v_org_id UUID;
BEGIN
  -- Step 1: Lock the job and derive organization_id from it
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    status := 'DENIED';
    reason := 'DRAFT_JOB_NOT_FOUND';
    RETURN;
  END IF;

  v_org_id := v_job.organization_id;

  -- Step 2: Check for existing reservation (before resolving quota period)
  SELECT * INTO v_reservation
  FROM public.draft_usage_reservations
  WHERE draft_generation_job_id = p_draft_generation_job_id
  FOR UPDATE;

  IF FOUND THEN
    -- Return existing reservation state regardless of quota period status
    IF v_reservation.status = 'reserved' THEN
      status := 'ALREADY_RESERVED';
      reason := NULL;
    ELSIF v_reservation.status = 'consumed' THEN
      status := 'ALREADY_CONSUMED';
      reason := NULL;
    ELSIF v_reservation.status = 'released' THEN
      status := 'RESERVATION_RELEASED';
      reason := NULL;
    END IF;
    RETURN;
  END IF;

  -- Step 3: No existing reservation. Resolve active quota period.
  SELECT id, hard_ceiling, period_start, period_end INTO v_quota_limit
  FROM public.draft_quota_limits
  WHERE organization_id = v_org_id
    AND CURRENT_DATE >= period_start
    AND CURRENT_DATE < period_end
  ORDER BY period_start DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    status := 'DENIED';
    reason := 'NO_ACTIVE_QUOTA_PERIOD';
    RETURN;
  END IF;

  -- Step 4: Create or lock usage tracking row
  INSERT INTO public.draft_usage_tracking (
    organization_id, quota_limit_id, period_start, period_end,
    draft_count, reserved_count
  )
  VALUES (
    v_org_id, v_quota_limit.id, v_quota_limit.period_start,
    v_quota_limit.period_end, 0, 0
  )
  ON CONFLICT (organization_id, quota_limit_id) DO NOTHING;

  SELECT * INTO v_usage
  FROM public.draft_usage_tracking
  WHERE organization_id = v_org_id
    AND quota_limit_id = v_quota_limit.id
  FOR UPDATE;

  -- Step 5: Check hard ceiling
  IF v_usage.draft_count + v_usage.reserved_count >= v_quota_limit.hard_ceiling THEN
    status := 'DENIED';
    reason := 'ENTITLEMENT_EXCEEDED';
    RETURN;
  END IF;

  -- Step 6: Insert reservation with ON CONFLICT DO NOTHING
  INSERT INTO public.draft_usage_reservations (
    organization_id, draft_generation_job_id, quota_limit_id, status
  )
  VALUES (
    v_org_id, p_draft_generation_job_id, v_quota_limit.id, 'reserved'
  )
  ON CONFLICT (draft_generation_job_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    -- Step 7: Increment reserved_count
    UPDATE public.draft_usage_tracking
    SET reserved_count = reserved_count + 1
    WHERE organization_id = v_org_id
      AND quota_limit_id = v_quota_limit.id;

    status := 'NEWLY_RESERVED';
    reason := NULL;
  ELSE
    -- Step 8: Another transaction won the race. Reload and return its state.
    SELECT * INTO v_reservation
    FROM public.draft_usage_reservations
    WHERE draft_generation_job_id = p_draft_generation_job_id
    FOR UPDATE;

    IF v_reservation.status = 'reserved' THEN
      status := 'ALREADY_RESERVED';
    ELSIF v_reservation.status = 'consumed' THEN
      status := 'ALREADY_CONSUMED';
    ELSIF v_reservation.status = 'released' THEN
      status := 'RESERVATION_RELEASED';
    END IF;
    reason := NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.reserve_draft_usage(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.reserve_draft_usage(UUID)
  TO service_role;

-- -----------------------------------------------------------------------------
-- private.consume_draft_reservation: Consume a reserved quota slot
-- Derives organization_id from the locked job row.
-- Returns: TEXT status ('CONSUMED', 'ALREADY_CONSUMED', 'NO_RESERVATION')
-- Raises: P3B07 DRAFT_JOB_NOT_FOUND
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.consume_draft_reservation(
  p_draft_generation_job_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_reservation RECORD;
  v_rows INT;
BEGIN
  -- Step 1: Lock the job and derive organization_id from it
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_JOB_NOT_FOUND' USING ERRCODE = 'P3B07';
  END IF;

  -- Step 2: Lock the reservation
  SELECT * INTO v_reservation
  FROM public.draft_usage_reservations
  WHERE draft_generation_job_id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NO_RESERVATION';
  END IF;

  -- Step 3: Check current status
  IF v_reservation.status = 'consumed' THEN
    RETURN 'ALREADY_CONSUMED';
  END IF;

  IF v_reservation.status = 'released' THEN
    RETURN 'NO_RESERVATION';
  END IF;

  -- Step 4: Consume: update reservation status
  UPDATE public.draft_usage_reservations
  SET status = 'consumed', updated_at = pg_catalog.now()
  WHERE id = v_reservation.id AND status = 'reserved';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- Race: another transaction consumed it
    RETURN 'ALREADY_CONSUMED';
  END IF;

  -- Step 5: Update usage tracking (decrement reserved, increment consumed)
  UPDATE public.draft_usage_tracking
  SET reserved_count = GREATEST(reserved_count - 1, 0),
      draft_count = draft_count + 1
  WHERE organization_id = v_reservation.organization_id
    AND quota_limit_id = v_reservation.quota_limit_id;

  RETURN 'CONSUMED';
END;
$$;

REVOKE ALL ON FUNCTION private.consume_draft_reservation(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.consume_draft_reservation(UUID)
  TO service_role;

-- -----------------------------------------------------------------------------
-- private.release_draft_reservation_internal: Release a reserved quota slot
-- Derives organization_id from the locked job row.
-- Returns: TEXT ('RELEASED', 'NO_RESERVATION', 'ALREADY_CONSUMED', 'ALREADY_RELEASED')
-- Raises: P3B07 DRAFT_JOB_NOT_FOUND, P3B11 QUOTA_RESERVATION_STATE_ERROR
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.release_draft_reservation_internal(
  p_draft_generation_job_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_reservation RECORD;
  v_usage RECORD;
  v_decremented INT;
BEGIN
  -- Step 1: Lock the job. If not found, raise P3B07.
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_JOB_NOT_FOUND' USING ERRCODE = 'P3B07';
  END IF;

  -- Step 2: Lock the reservation. If not found, return NO_RESERVATION.
  SELECT * INTO v_reservation
  FROM public.draft_usage_reservations
  WHERE draft_generation_job_id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NO_RESERVATION';
  END IF;

  -- Step 3: Return early for consumed or released
  IF v_reservation.status = 'consumed' THEN
    RETURN 'ALREADY_CONSUMED';
  END IF;

  IF v_reservation.status = 'released' THEN
    RETURN 'ALREADY_RELEASED';
  END IF;

  -- Step 4: Lock the associated usage row
  SELECT * INTO v_usage
  FROM public.draft_usage_tracking
  WHERE organization_id = v_reservation.organization_id
    AND quota_limit_id = v_reservation.quota_limit_id
  FOR UPDATE;

  -- Step 5: If usage row is missing, raise P3B11
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTA_RESERVATION_STATE_ERROR' USING ERRCODE = 'P3B11';
  END IF;

  -- Step 6: If reserved_count < 1, raise P3B11
  IF v_usage.reserved_count < 1 THEN
    RAISE EXCEPTION 'QUOTA_RESERVATION_STATE_ERROR' USING ERRCODE = 'P3B11';
  END IF;

  -- Step 7: Guarded decrement
  UPDATE public.draft_usage_tracking
  SET reserved_count = reserved_count - 1
  WHERE organization_id = v_reservation.organization_id
    AND quota_limit_id = v_reservation.quota_limit_id
    AND reserved_count > 0
  RETURNING 1 INTO v_decremented;

  -- Step 8: If no row returned, raise P3B11
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTA_RESERVATION_STATE_ERROR' USING ERRCODE = 'P3B11';
  END IF;

  -- Step 9: Mark reservation released
  UPDATE public.draft_usage_reservations
  SET status = 'released', updated_at = pg_catalog.now()
  WHERE id = v_reservation.id AND status = 'reserved';

  RETURN 'RELEASED';
END;
$$;

REVOKE ALL ON FUNCTION private.release_draft_reservation_internal(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.release_draft_reservation_internal(UUID)
  TO service_role;

-- -----------------------------------------------------------------------------
-- private.store_draft: Atomically store a draft, consume quota, mark job completed
-- Derives organization_id from the locked job row.
-- Returns: UUID (the draft id)
-- Raises: P3B07 DRAFT_JOB_NOT_FOUND, P3B10 INVALID_DRAFT_JOB_STATE, P3B14 DRAFT_TENANT_MISMATCH
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.store_draft(
  p_draft_generation_job_id UUID,
  p_business_profile_id UUID,
  p_conversation_id UUID,
  p_source_message_id UUID,
  p_body TEXT,
  p_provider TEXT,
  p_model TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_reservation RECORD;
  v_org_id UUID;
  v_draft_id UUID;
  v_revision_id UUID;
  v_consume_result TEXT;
BEGIN
  -- Step 1: Lock the job and derive organization_id from it
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_JOB_NOT_FOUND' USING ERRCODE = 'P3B07';
  END IF;

  v_org_id := v_job.organization_id;

  -- Step 1b: Validate that supplied identifiers belong to the locked job
  -- business_profile_id must belong to the same organization
  IF p_business_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.business_profiles
    WHERE id = p_business_profile_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'DRAFT_TENANT_MISMATCH' USING ERRCODE = 'P3B14';
  END IF;

  -- conversation_id must belong to the same organization and match the job's conversation
  IF p_conversation_id IS NULL OR p_conversation_id <> v_job.conversation_id OR NOT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'DRAFT_TENANT_MISMATCH' USING ERRCODE = 'P3B14';
  END IF;

  -- source_message_id must belong to the same organization and match the job's source message
  IF p_source_message_id IS NULL OR p_source_message_id <> v_job.source_message_id OR NOT EXISTS (
    SELECT 1 FROM public.messages
    WHERE id = p_source_message_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'DRAFT_TENANT_MISMATCH' USING ERRCODE = 'P3B14';
  END IF;

  -- Step 2: Lock the reservation
  SELECT * INTO v_reservation
  FROM public.draft_usage_reservations
  WHERE draft_generation_job_id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_reservation.status <> 'reserved' THEN
    RAISE EXCEPTION 'INVALID_DRAFT_JOB_STATE' USING ERRCODE = 'P3B10';
  END IF;

  -- Step 3: Insert ai_drafts (status='draft', version=1, no current_revision_id yet)
  INSERT INTO public.ai_drafts (
    organization_id, business_profile_id, conversation_id,
    source_message_id, status, version, provider, model
  )
  VALUES (
    v_org_id, p_business_profile_id, p_conversation_id,
    p_source_message_id, 'draft', 1, p_provider, p_model
  )
  RETURNING id INTO v_draft_id;

  -- Step 4: Insert initial revision (version=1, system actor)
  INSERT INTO public.ai_draft_revisions (
    organization_id, draft_id, version, body, created_by_type, created_by_user_id
  )
  VALUES (
    v_org_id, v_draft_id, 1, p_body, 'system', NULL
  )
  RETURNING id INTO v_revision_id;

  -- Step 5: Set current_revision_id on the draft
  UPDATE public.ai_drafts
  SET current_revision_id = v_revision_id
  WHERE id = v_draft_id;

  -- Step 6: Consume the reservation (atomically)
  v_consume_result := private.consume_draft_reservation(p_draft_generation_job_id);

  IF v_consume_result NOT IN ('CONSUMED', 'ALREADY_CONSUMED') THEN
    RAISE EXCEPTION 'INVALID_DRAFT_JOB_STATE' USING ERRCODE = 'P3B10';
  END IF;

  -- Step 7: Mark job completed
  UPDATE public.draft_generation_jobs
  SET status = 'completed', updated_at = pg_catalog.now()
  WHERE id = p_draft_generation_job_id;

  RETURN v_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION private.store_draft(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.store_draft(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- -----------------------------------------------------------------------------
-- private.archive_draft_failed_job: Dead-letter a failed draft generation job
-- Derives request_id, attempts, queue identity, and PGMQ message ID from the
-- locked job row. Does NOT accept caller-supplied request_id or attempts.
-- Returns: TABLE(archived BOOLEAN, already_archived BOOLEAN)
-- Raises: P3B07 DRAFT_JOB_NOT_FOUND, P3B12 DRAFT_ARCHIVE_STATE_ERROR,
--         P3B08 DRAFT_JOB_IDENTITY_MISMATCH, P3B14 DRAFT_TENANT_MISMATCH,
--         P3B15 INVALID_DRAFT_FAILURE_CODE, P3B16 INVALID_DRAFT_ATTEMPTS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.archive_draft_failed_job(
  p_msg_id BIGINT,
  p_draft_generation_job_id UUID,
  p_error_code TEXT
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

  -- Validate allowed error codes for dead-lettering
  IF p_error_code IS NULL OR p_error_code NOT IN (
    'DRAFT_EXHAUSTED_RETRIES',
    'DRAFT_PROVIDER_ERROR',
    'DRAFT_GENERATION_TIMEOUT',
    'DRAFT_QUOTA_EXCEEDED',
    'DRAFT_INTERNAL_ERROR'
  ) THEN
    RAISE EXCEPTION 'INVALID_DRAFT_FAILURE_CODE' USING ERRCODE = 'P3B15';
  END IF;

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
      attempts, queue_name, pgmq_msg_id
    )
    VALUES (
      NULL, v_job_type, v_derived_request_id, p_error_code,
      v_derived_attempts, v_queue_name, p_msg_id
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

REVOKE ALL ON FUNCTION private.archive_draft_failed_job(BIGINT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.archive_draft_failed_job(BIGINT, UUID, TEXT)
  TO service_role;

-- -----------------------------------------------------------------------------
-- private.skip_draft_job: Skip a draft generation job (non-dead-letter skip)
-- Releases reservation, deletes queue message, marks job skipped
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.skip_draft_job(
  p_draft_generation_job_id UUID,
  p_msg_id BIGINT,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_job RECORD;
  v_release_result TEXT;
  v_delete_result BOOLEAN;
BEGIN
  -- Lock the job
  SELECT * INTO v_job
  FROM public.draft_generation_jobs
  WHERE id = p_draft_generation_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_JOB_NOT_FOUND' USING ERRCODE = 'P3B07';
  END IF;

  -- Release the reservation if one exists
  v_release_result := private.release_draft_reservation_internal(p_draft_generation_job_id);

  -- Mark job as skipped
  UPDATE public.draft_generation_jobs
  SET status = 'skipped',
      skip_reason = p_skip_reason,
      updated_at = pg_catalog.now()
  WHERE id = p_draft_generation_job_id;

  -- Delete the PGMQ message
  v_delete_result := pgmq.delete('draft_generation', p_msg_id);

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION private.skip_draft_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.skip_draft_job(UUID, BIGINT, TEXT)
  TO service_role;

-- =============================================================================
-- PUBLIC SCHEMA: Queue wrapper RPCs for draft_generation queue
-- Service-role only, SECURITY DEFINER
-- =============================================================================

-- read_draft_generation_jobs: read messages from the draft_generation queue
-- Reconciles draft_generation_jobs.attempts to the authoritative PGMQ read_ct.
-- PGMQ read_ct is the source of truth for delivery attempts.
-- This is the production claim path: a newly enqueued job has attempts=0,
-- and the first call to this RPC reconciles it to read_ct=1.
-- Never blindly increments: sets attempts = read_ct exactly.
--
-- Reconciliation contract (per Round 8 review):
--   Stored msg_id absent:  bind it to the actual PGMQ msg_id
--   Stored msg_id differs: raise P3B08 DRAFT_JOB_IDENTITY_MISMATCH
--   read_ct < stored attempts: raise P3B16 INVALID_DRAFT_ATTEMPTS (decrease rejected)
--   read_ct = stored attempts: idempotent handling of the same delivery
--   read_ct > stored attempts: reconcile stored attempts to authoritative read_ct
--
-- Terminal path for read_ct > 3 (over-limit delivery):
--   lock and verify the job
--   record the authoritative read_ct
--   avoid a fourth provider call
--   use DRAFT_EXHAUSTED_RETRIES
--   release a reserved reservation exactly once, when applicable
--   preserve a consumed reservation
--   insert failed_jobs exactly once
--   mark the job dead_lettered
--   delete or confirm absence of the PGMQ message
--   return no provider work
CREATE OR REPLACE FUNCTION public.read_draft_generation_jobs(
  p_visibility_timeout_seconds INT DEFAULT 30,
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
  v_limit INT := LEAST(GREATEST(p_limit, 1), 10);
  v_row RECORD;
  v_job RECORD;
  v_job_id UUID;
  v_term_archived BOOLEAN;
  v_term_already BOOLEAN;
BEGIN
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  -- Read messages from PGMQ into a temp table.
  -- pgmq.read() is a set-returning function; we materialize its result
  -- into a temp table so we can iterate, reconcile, and filter.
  CREATE TEMP TABLE _draft_claimed ON COMMIT DROP AS
  SELECT r.msg_id, r.read_ct, r.message AS payload, r.enqueued_at, r.vt
  FROM pgmq.read('draft_generation', p_visibility_timeout_seconds, v_limit) AS r;

  -- Reconcile each claimed job to the authoritative PGMQ read_ct
  FOR v_row IN SELECT * FROM _draft_claimed LOOP
    v_job_id := (v_row.payload->>'draftGenerationJobId')::UUID;
    IF v_job_id IS NOT NULL THEN

      -- Lock the job row for safe reconciliation
      SELECT * INTO v_job
      FROM public.draft_generation_jobs
      WHERE id = v_job_id
      FOR UPDATE;

      IF NOT FOUND THEN
        -- Job not found in database; skip reconciliation but still return message
        CONTINUE;
      END IF;

      -- ---------------------------------------------------------------
      -- 1. Stored message ID handling
      -- ---------------------------------------------------------------

      IF v_job.pgmq_msg_id IS NULL THEN
        -- First claim: bind the stored msg_id to the actual PGMQ msg_id
        -- This is the normal path for a newly enqueued job.
        UPDATE public.draft_generation_jobs
        SET pgmq_msg_id = v_row.msg_id
        WHERE id = v_job_id;

      ELSIF v_job.pgmq_msg_id <> v_row.msg_id THEN
        -- Stored msg_id differs from the actual PGMQ msg_id.
        -- This indicates a queue/database identity mismatch.
        RAISE EXCEPTION 'DRAFT_JOB_IDENTITY_MISMATCH' USING ERRCODE = 'P3B08';
      END IF;

      -- ---------------------------------------------------------------
      -- 2. read_ct vs stored attempts reconciliation
      -- ---------------------------------------------------------------

      IF v_row.read_ct < v_job.attempts THEN
        -- Decreasing read_ct: explicitly reject.
        -- read_ct is the authoritative delivery count from PGMQ.
        -- A decreasing value indicates internal state corruption.
        RAISE EXCEPTION 'INVALID_DRAFT_ATTEMPTS' USING ERRCODE = 'P3B16';

      ELSIF v_row.read_ct = v_job.attempts THEN
        -- Idempotent: same delivery (same msg_id, same read_ct).
        -- No increment needed. pgmq_msg_id already bound above.
        NULL;

      ELSIF v_row.read_ct > v_job.attempts THEN
        -- Reconcile: set stored attempts to the authoritative read_ct.
        -- This is the normal path for a new delivery (read_ct incremented by PGMQ).
        -- Exception: when read_ct > 3, we do NOT set attempts = read_ct
        -- because the 4th delivery never results in a provider call.
        -- The terminal path below archives with attempts = 3 (the last
        -- real provider attempt count), not read_ct = 4.
        IF v_row.read_ct <= 3 THEN
          UPDATE public.draft_generation_jobs
          SET attempts = v_row.read_ct
          WHERE id = v_job_id;
        END IF;
      END IF;

      -- ---------------------------------------------------------------
      -- 3. Terminal path for read_ct > 3 (over-limit delivery)
      -- ---------------------------------------------------------------

      IF v_row.read_ct > 3 THEN
        -- Deterministic terminal path: no fourth provider call.
        -- The job is already locked and attempts = read_ct is recorded.
        -- archive_draft_failed_job will:
        --   - release a reserved reservation exactly once (if applicable)
        --   - preserve a consumed reservation
        --   - insert failed_jobs exactly once
        --   - mark the job dead_lettered
        --   - archive (delete) the PGMQ message
        SELECT archived, already_archived INTO v_term_archived, v_term_already
        FROM private.archive_draft_failed_job(
          v_row.msg_id,
          v_job_id,
          'DRAFT_EXHAUSTED_RETRIES'
        );

        -- Remove this message from the result set: return no provider work.
        DELETE FROM _draft_claimed WHERE _draft_claimed.msg_id = v_row.msg_id;
      END IF;

    END IF;
  END LOOP;

  -- Return only non-terminal messages (provider work to do)
  RETURN QUERY SELECT * FROM _draft_claimed;

  DROP TABLE _draft_claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.read_draft_generation_jobs(INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_draft_generation_jobs(INT, INT)
  TO service_role;

-- delete_draft_generation_job: delete a message from the queue
CREATE OR REPLACE FUNCTION public.delete_draft_generation_job(
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
  v_result := pgmq.delete('draft_generation', p_msg_id);
  RETURN COALESCE(v_result, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_draft_generation_job(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_draft_generation_job(BIGINT)
  TO service_role;

-- set_draft_generation_visibility: extend visibility timeout
CREATE OR REPLACE FUNCTION public.set_draft_generation_visibility(
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
  IF p_visibility_timeout_seconds < 1 OR p_visibility_timeout_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY_TIMEOUT' USING ERRCODE = '90007';
  END IF;

  v_record := pgmq.set_vt('draft_generation', p_msg_id, p_visibility_timeout_seconds);
  RETURN v_record IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.set_draft_generation_visibility(BIGINT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_draft_generation_visibility(BIGINT, INT)
  TO service_role;