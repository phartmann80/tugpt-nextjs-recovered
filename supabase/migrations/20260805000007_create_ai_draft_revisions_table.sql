-- Phase 3B: ai_draft_revisions table (immutable, with actor model)
-- Migration: 20260805000007_create_ai_draft_revisions_table.sql

CREATE TABLE IF NOT EXISTS public.ai_draft_revisions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  version INTEGER NOT NULL
    CHECK (version >= 1),
  body TEXT NOT NULL,
  created_by_type TEXT NOT NULL
    CHECK (created_by_type IN ('system', 'user')),
  created_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- One revision per version per draft
ALTER TABLE public.ai_draft_revisions
  ADD CONSTRAINT ai_draft_revisions_org_draft_version_unique
  UNIQUE (organization_id, draft_id, version);

-- Composite FK: revision must belong to the same org as its draft
ALTER TABLE public.ai_draft_revisions
  ADD CONSTRAINT ai_draft_revisions_draft_org_fk
  FOREIGN KEY (organization_id, draft_id)
  REFERENCES public.ai_drafts(organization_id, id)
  ON DELETE CASCADE;

-- When created_by_type = 'system', created_by_user_id must be NULL
ALTER TABLE public.ai_draft_revisions
  ADD CONSTRAINT ai_draft_revisions_system_actor_null_user
  CHECK (
    (created_by_type = 'system' AND created_by_user_id IS NULL)
    OR (created_by_type = 'user' AND created_by_user_id IS NOT NULL)
  );

CREATE INDEX idx_ai_draft_revisions_org_id ON public.ai_draft_revisions(organization_id);
CREATE INDEX idx_ai_draft_revisions_draft_id ON public.ai_draft_revisions(draft_id);
CREATE INDEX idx_ai_draft_revisions_version ON public.ai_draft_revisions(version);

-- RLS: enabled, org members can SELECT, service_role only for INSERT/UPDATE/DELETE
ALTER TABLE public.ai_draft_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_draft_revisions_select
  ON public.ai_draft_revisions
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_draft_revisions TO service_role;
GRANT SELECT ON public.ai_draft_revisions TO authenticated;