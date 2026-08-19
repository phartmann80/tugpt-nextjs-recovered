-- Migration: 20260819000003_draft_audit_boundary_and_job_attribution.sql
--
-- Findings #2 and #3 from the 2026-08-19 milestone-1 run.
--
-- FINDING #3 (job attribution)
-- The completed draft_generation_jobs row carried provider = NULL, model = NULL
-- while the ai_drafts row it produced carried langdock / gpt-5-mini.
-- private.store_draft already receives p_provider and p_model and writes them
-- to the draft; it just never wrote them to the job row it marks completed.
-- Without that, per-model attribution has to be reconstructed by joining back
-- through the draft, and a job that failed after choosing a model records
-- nothing at all. Model rotation makes this worse, so it is fixed here first.
--
-- FINDING #2 (audit boundary)
-- The evidence pack showed `auditLogs: []` while review events had been
-- written, which read as "no audit trail". It is not: draft review actions are
-- recorded in ai_draft_review_events, and always have been. audit_logs has
-- exactly two writers, both in 20260716000001 — create_organization
-- ('organization.create') and accept_invitation ('invitation.accept').
--
-- The decision, made explicit here and in ADR-009: draft review actions are
-- recorded in ai_draft_review_events ONLY, and that table is the audit record
-- of those actions. They are not mirrored into audit_logs. Two tables holding
-- the same events would be two sources of truth that drift, and the domain
-- table already carries what audit_logs cannot express (previous_version /
-- new_version, and the composite FK that makes an event belong to its draft's
-- organization by construction).
--
-- What that decision obliges us to fix, and this migration does:
--   1. Append-only must be stated, not merely implied by which grants happen
--      to be absent.
--   2. actor_id was NOT NULL with ON DELETE SET NULL — a contradiction that
--      makes deleting any profile that has ever reviewed a draft fail with a
--      not-null violation, which would block user offboarding and erasure.
-- Section 2a records a third change that was considered and rejected, with the
-- reason, because its absence otherwise looks like an oversight.

-- -----------------------------------------------------------------------------
-- 1. Finding #3 — record provider and model on the job row at completion
--
-- CREATE OR REPLACE with an identical signature: no grants change, no
-- dependent object is invalidated. The ONLY behavioural difference is in
-- step 7.
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

  -- Step 7: Mark job completed, recording which provider and model produced it.
  --
  -- CHANGED 2026-08-19 (finding #3): provider and model were previously left
  -- NULL on the job row even though this function already had both values.
  -- COALESCE keeps whatever the job already recorded if the caller passes NULL,
  -- so a worker that attributed the job earlier cannot have that erased.
  -- (COALESCE is a SQL construct, not a function: it cannot be schema-qualified
  -- and is unaffected by search_path.)
  UPDATE public.draft_generation_jobs
  SET status = 'completed',
      provider = COALESCE(p_provider, provider),
      model = COALESCE(p_model, model),
      updated_at = pg_catalog.now()
  WHERE id = p_draft_generation_job_id;

  RETURN v_draft_id;
END;
$$;

COMMENT ON FUNCTION private.store_draft(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) IS
  'Persists a generated draft, its first revision, and the quota consumption, and marks the job completed with the provider and model that produced it.';

-- -----------------------------------------------------------------------------
-- 2. Finding #2 — make ai_draft_review_events actually carry the role it has
-- -----------------------------------------------------------------------------

-- 2a. FORCE ROW LEVEL SECURITY was considered here and deliberately NOT added.
--     Recorded because "this table is ENABLE while every comparable table is
--     FORCE" looks like an oversight, and the next person will otherwise
--     rediscover the following the hard way:
--
--       * It would buy nothing. FORCE changes behaviour only for the table
--         owner, and the owner (postgres) holds BYPASSRLS, so RLS is skipped
--         for it either way.
--       * It would break the write path unless a permissive INSERT policy were
--         added — and, if any writer ever used RETURNING, a permissive SELECT
--         policy too, because PostgreSQL evaluates the SELECT policy for the
--         RETURNING read-back and reports the failure as
--         "new row violates row-level security policy", which reads like a
--         WITH CHECK failure and sends you looking in the wrong place.
--         (Verified on PostgreSQL 16.13 with a non-BYPASSRLS owner.)
--       * That SELECT policy could not be scoped to the definer, so it would
--         have to be permissive to PUBLIC — which would let any authenticated
--         session read every organization's review events. Tenant isolation is
--         worth more than schema symmetry.
--
--     The protection that actually matters is privilege, below.

-- 2b. State append-only rather than leaving it to be inferred from which
--     grants happen to be absent. No role has ever held UPDATE or DELETE
--     here; this makes that a decision instead of an omission.
REVOKE UPDATE, DELETE ON public.ai_draft_review_events FROM PUBLIC, anon, authenticated, service_role;

-- 2c. actor_id: NOT NULL and ON DELETE SET NULL contradict each other.
--     Deleting a profile that has reviewed a draft currently fails with
--     "null value in column actor_id violates not-null constraint", which
--     blocks offboarding and erasure. audit_logs.user_id already resolves the
--     same tension the other way (nullable + SET NULL); match it. Every writer
--     is a SECURITY DEFINER RPC that passes auth.uid(), so in practice the
--     column is only ever NULL for an actor who has since been erased.
ALTER TABLE public.ai_draft_review_events ALTER COLUMN actor_id DROP NOT NULL;

COMMENT ON TABLE public.ai_draft_review_events IS
  'Audit record for human review of AI drafts (approve / edit / reject). This table, not audit_logs, is the record of those actions — see ADR-009. Append-only: no role holds UPDATE or DELETE.';

COMMENT ON COLUMN public.ai_draft_review_events.actor_id IS
  'The reviewer. NULL only when that profile has since been deleted; every writer supplies auth.uid().';

COMMENT ON TABLE public.audit_logs IS
  'Organization and membership lifecycle events (organization.create, invitation.accept). Draft review actions are NOT recorded here — see ai_draft_review_events and ADR-009.';
