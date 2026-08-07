-- Phase 3B: Human review RPCs (approve, edit, reject)
-- Migration: 20260805000016_create_human_review_rpcs.sql

-- All review RPCs: SECURITY DEFINER, SET search_path = pg_catalog
-- All table, function, and type references are fully qualified.
-- REVOKE FROM PUBLIC/anon, GRANT TO authenticated and service_role.
--
-- SECURITY: organization_id is derived from the locked draft row.
-- The browser never supplies the organization scope.

-- -----------------------------------------------------------------------------
-- public.approve_draft: Approve a draft with optimistic concurrency
-- Signature: approve_draft(p_draft_id, p_expected_lock_version)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_draft(
  p_draft_id UUID,
  p_expected_lock_version INTEGER
)
RETURNS TABLE(
  id UUID,
  status TEXT,
  version INTEGER,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_draft RECORD;
  v_rows INT;
BEGIN
  -- Step 1: Lock the draft row and derive organization_id from it
  SELECT * INTO v_draft
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P3B01';
  END IF;

  -- Step 2: Verify org membership and role using the derived organization_id
  IF NOT private.is_org_member(v_draft.organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  IF NOT private.has_org_role(v_draft.organization_id, auth.uid(),
    ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  -- Step 3: Check current status before versioned update
  IF v_draft.status NOT IN ('draft') THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION' USING ERRCODE = 'P3B04';
  END IF;

  -- Step 4: Atomic versioned update
  UPDATE public.ai_drafts
  SET status = 'approved',
      version = public.ai_drafts.version + 1,
      reviewed_by = auth.uid(),
      reviewed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE public.ai_drafts.id = p_draft_id
    AND public.ai_drafts.version = p_expected_lock_version
    AND public.ai_drafts.status = 'draft';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P3B03';
  END IF;

  -- Step 5: Insert review event
  INSERT INTO public.ai_draft_review_events (
    organization_id, draft_id, action, actor_id,
    previous_version, new_version
  )
  VALUES (
    v_draft.organization_id, p_draft_id, 'approve', auth.uid(),
    p_expected_lock_version, p_expected_lock_version + 1
  );

  RETURN QUERY
  SELECT public.ai_drafts.id,
         public.ai_drafts.status,
         public.ai_drafts.version,
         public.ai_drafts.reviewed_at,
         public.ai_drafts.reviewed_by
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_draft(UUID, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_draft(UUID, INTEGER)
  TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- public.edit_draft: Edit a draft body with optimistic concurrency (creates new revision)
-- Signature: edit_draft(p_draft_id, p_expected_lock_version, p_body)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_draft(
  p_draft_id UUID,
  p_expected_lock_version INTEGER,
  p_body TEXT
)
RETURNS TABLE(
  id UUID,
  status TEXT,
  version INTEGER,
  current_revision_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_draft RECORD;
  v_rows INT;
  v_revision_id UUID;
BEGIN
  -- Validate body is not NULL or empty
  IF p_body IS NULL OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'INVALID_BODY' USING ERRCODE = 'P3B05';
  END IF;

  -- Step 1: Lock the draft row and derive organization_id from it
  SELECT * INTO v_draft
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P3B01';
  END IF;

  -- Step 2: Verify org membership and role using the derived organization_id
  IF NOT private.is_org_member(v_draft.organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  IF NOT private.has_org_role(v_draft.organization_id, auth.uid(),
    ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  -- Step 3: Insert new revision (version = expected + 1)
  INSERT INTO public.ai_draft_revisions (
    organization_id, draft_id, version, body,
    created_by_type, created_by_user_id
  )
  VALUES (
    v_draft.organization_id, p_draft_id, p_expected_lock_version + 1, p_body,
    'user', auth.uid()
  )
  RETURNING public.ai_draft_revisions.id INTO v_revision_id;

  -- Step 4: Atomic versioned update (only drafts can be edited, not rejected/approved)
  UPDATE public.ai_drafts
  SET current_revision_id = v_revision_id,
      version = public.ai_drafts.version + 1,
      status = 'draft',
      reviewed_by = NULL,
      reviewed_at = NULL,
      updated_at = pg_catalog.now()
  WHERE public.ai_drafts.id = p_draft_id
    AND public.ai_drafts.version = p_expected_lock_version
    AND public.ai_drafts.status = 'draft';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    -- Stale version: rollback the revision insert too
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P3B03';
  END IF;

  -- Step 5: Insert review event
  INSERT INTO public.ai_draft_review_events (
    organization_id, draft_id, action, actor_id,
    previous_version, new_version
  )
  VALUES (
    v_draft.organization_id, p_draft_id, 'edit', auth.uid(),
    p_expected_lock_version, p_expected_lock_version + 1
  );

  RETURN QUERY
  SELECT public.ai_drafts.id,
         public.ai_drafts.status,
         public.ai_drafts.version,
         public.ai_drafts.current_revision_id
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_draft(UUID, INTEGER, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_draft(UUID, INTEGER, TEXT)
  TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- public.reject_draft: Reject a draft with optimistic concurrency
-- Signature: reject_draft(p_draft_id, p_expected_lock_version)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_draft(
  p_draft_id UUID,
  p_expected_lock_version INTEGER
)
RETURNS TABLE(
  id UUID,
  status TEXT,
  version INTEGER,
  rejected_at TIMESTAMPTZ,
  rejected_by UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_draft RECORD;
  v_rows INT;
BEGIN
  -- Step 1: Lock the draft row and derive organization_id from it
  SELECT * INTO v_draft
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P3B01';
  END IF;

  -- Step 2: Verify org membership and role using the derived organization_id
  IF NOT private.is_org_member(v_draft.organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  IF NOT private.has_org_role(v_draft.organization_id, auth.uid(),
    ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3B02';
  END IF;

  -- Step 3: Atomic versioned update
  UPDATE public.ai_drafts
  SET status = 'rejected',
      version = public.ai_drafts.version + 1,
      rejected_by = auth.uid(),
      rejected_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE public.ai_drafts.id = p_draft_id
    AND public.ai_drafts.version = p_expected_lock_version
    AND public.ai_drafts.status = 'draft';

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P3B03';
  END IF;

  -- Step 4: Insert review event
  INSERT INTO public.ai_draft_review_events (
    organization_id, draft_id, action, actor_id,
    previous_version, new_version
  )
  VALUES (
    v_draft.organization_id, p_draft_id, 'reject', auth.uid(),
    p_expected_lock_version, p_expected_lock_version + 1
  );

  RETURN QUERY
  SELECT public.ai_drafts.id,
         public.ai_drafts.status,
         public.ai_drafts.version,
         public.ai_drafts.rejected_at,
         public.ai_drafts.rejected_by
  FROM public.ai_drafts
  WHERE public.ai_drafts.id = p_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_draft(UUID, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_draft(UUID, INTEGER)
  TO anon, authenticated, service_role;