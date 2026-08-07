-- Phase 3B: ai_draft_review_events table (append-only audit trail)
-- Migration: 20260805000009_create_ai_draft_review_events_table.sql

CREATE TABLE IF NOT EXISTS public.ai_draft_review_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('approve', 'edit', 'reject')),
  actor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  previous_version INTEGER NOT NULL
    CHECK (previous_version >= 1),
  new_version INTEGER NOT NULL
    CHECK (new_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite FK: review event must belong to the same org as its draft
ALTER TABLE public.ai_draft_review_events
  ADD CONSTRAINT ai_draft_review_events_draft_org_fk
  FOREIGN KEY (organization_id, draft_id)
  REFERENCES public.ai_drafts(organization_id, id)
  ON DELETE CASCADE;

CREATE INDEX idx_ai_draft_review_events_org_id ON public.ai_draft_review_events(organization_id);
CREATE INDEX idx_ai_draft_review_events_draft_id ON public.ai_draft_review_events(draft_id);
CREATE INDEX idx_ai_draft_review_events_actor_id ON public.ai_draft_review_events(actor_id);

-- RLS: enabled, org members can SELECT, service_role only for INSERT
ALTER TABLE public.ai_draft_review_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_draft_review_events_select
  ON public.ai_draft_review_events
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

GRANT SELECT, INSERT ON public.ai_draft_review_events TO service_role;
GRANT SELECT ON public.ai_draft_review_events TO authenticated;