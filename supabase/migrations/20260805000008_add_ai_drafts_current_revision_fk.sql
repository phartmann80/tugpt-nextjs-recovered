-- Phase 3B: Add current_revision_id to ai_drafts (circular FK resolution)
-- Migration: 20260805000008_add_ai_drafts_current_revision_fk.sql

-- Add the column (nullable initially)
ALTER TABLE public.ai_drafts
  ADD COLUMN IF NOT EXISTS current_revision_id UUID;

-- Add composite unique constraint on ai_draft_revisions for the FK target (id, organization_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_draft_revisions_id_organization_unique'
  ) THEN
    ALTER TABLE public.ai_draft_revisions ADD CONSTRAINT ai_draft_revisions_id_organization_unique UNIQUE (id, organization_id);
  END IF;
END
$$;

-- Composite FK: current_revision_id must belong to the same org as the draft
-- ON DELETE RESTRICT prevents deleting the current revision
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_current_revision_fk
  FOREIGN KEY (organization_id, current_revision_id)
  REFERENCES public.ai_draft_revisions(organization_id, id)
  ON DELETE RESTRICT;

-- =============================================================================
-- Deferred constraint trigger: enforce that every surviving (non-deleted) draft
-- has a non-null current_revision_id at commit time.
-- The composite FK alone does not enforce this: it only validates that a
-- non-null revision belongs to the correct draft. This trigger rejects any
-- draft whose current_revision_id IS NULL when the transaction commits.
-- =============================================================================
CREATE OR REPLACE FUNCTION private.enforce_current_revision_not_null()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_bad_count INT;
BEGIN
  SELECT COUNT(*) INTO v_bad_count
  FROM public.ai_drafts
  WHERE current_revision_id IS NULL;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'DRAFT_CURRENT_REVISION_REQUIRED'
      USING ERRCODE = 'P3B13',
            MESSAGE = 'Every surviving draft must have a non-null current_revision_id';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_current_revision_not_null()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.enforce_current_revision_not_null()
  TO service_role;

-- Deferred constraint trigger fires at COMMIT time, after all rows are settled
CREATE CONSTRAINT TRIGGER enforce_current_revision_not_null
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_drafts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_current_revision_not_null();