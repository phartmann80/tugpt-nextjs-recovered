-- Phase 3B Stage 4A: Public service-role wrappers for private draft RPCs
-- Migration: 20260805000018_create_draft_rpc_public_wrappers.sql
--
-- Per Paul's amendment #4: The private schema must not be exposed through
-- PostgREST. These are narrowly scoped public, service-role-only wrappers
-- around the private helpers needed by the draft worker.
--
-- Requirements:
--   SECURITY DEFINER
--   SET search_path = pg_catalog
--   fully qualified references
--   REVOKE ALL FROM PUBLIC
--   no anon execution
--   no authenticated execution
--   service_role only
--   private schema remains unexposed

-- =============================================================================
-- public.reserve_draft_usage: Wrapper for private.reserve_draft_usage
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reserve_draft_usage(
  p_draft_generation_job_id UUID
)
RETURNS TABLE(status TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_status TEXT;
  v_reason TEXT;
BEGIN
  SELECT * INTO v_status, v_reason
  FROM private.reserve_draft_usage(p_draft_generation_job_id);

  RETURN QUERY SELECT v_status, v_reason;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_draft_usage(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_draft_usage(UUID)
  TO service_role;

-- =============================================================================
-- public.store_draft: Wrapper for private.store_draft
-- =============================================================================
CREATE OR REPLACE FUNCTION public.store_draft(
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
  v_draft_id UUID;
BEGIN
  SELECT private.store_draft(
    p_draft_generation_job_id,
    p_business_profile_id,
    p_conversation_id,
    p_source_message_id,
    p_body,
    p_provider,
    p_model
  ) INTO v_draft_id;

  RETURN v_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_draft(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_draft(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- =============================================================================
-- public.archive_draft_failed_job: Wrapper for private.archive_draft_failed_job
-- =============================================================================
CREATE OR REPLACE FUNCTION public.archive_draft_failed_job(
  p_msg_id BIGINT,
  p_draft_generation_job_id UUID,
  p_error_code TEXT
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
    p_error_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_draft_failed_job(BIGINT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_draft_failed_job(BIGINT, UUID, TEXT)
  TO service_role;

-- =============================================================================
-- public.skip_draft_job: Wrapper for private.skip_draft_job
-- =============================================================================
CREATE OR REPLACE FUNCTION public.skip_draft_job(
  p_draft_generation_job_id UUID,
  p_msg_id BIGINT,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN private.skip_draft_job(
    p_draft_generation_job_id,
    p_msg_id,
    p_skip_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.skip_draft_job(UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skip_draft_job(UUID, BIGINT, TEXT)
  TO service_role;