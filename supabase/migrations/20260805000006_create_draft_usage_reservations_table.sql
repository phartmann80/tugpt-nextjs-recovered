-- Phase 3B: draft_usage_reservations table
-- Migration: 20260805000006_create_draft_usage_reservations_table.sql

CREATE TABLE IF NOT EXISTS public.draft_usage_reservations (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  draft_generation_job_id UUID NOT NULL,
  quota_limit_id UUID REFERENCES public.draft_quota_limits(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Exactly one reservation per job
ALTER TABLE public.draft_usage_reservations
  ADD CONSTRAINT draft_usage_reservations_job_uk
  UNIQUE (draft_generation_job_id);

-- Composite FK: reservation must belong to the same org as its job
ALTER TABLE public.draft_usage_reservations
  ADD CONSTRAINT draft_usage_reservations_org_job_fk
  FOREIGN KEY (organization_id, draft_generation_job_id)
  REFERENCES public.draft_generation_jobs(organization_id, id)
  ON DELETE CASCADE;

CREATE INDEX idx_draft_usage_reservations_org_id ON public.draft_usage_reservations(organization_id);
CREATE INDEX idx_draft_usage_reservations_job_id ON public.draft_usage_reservations(draft_generation_job_id);
CREATE INDEX idx_draft_usage_reservations_quota_limit_id ON public.draft_usage_reservations(quota_limit_id);
CREATE INDEX idx_draft_usage_reservations_status ON public.draft_usage_reservations(status);

-- RLS: ENABLED + FORCE, service-role only (operational table)
ALTER TABLE public.draft_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_usage_reservations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_usage_reservations TO service_role;
REVOKE ALL ON public.draft_usage_reservations FROM authenticated, anon;

-- updated_at trigger
CREATE TRIGGER trigger_draft_usage_reservations_updated_at
  BEFORE UPDATE ON public.draft_usage_reservations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();