-- Phase 3B: draft_quota_limits table
-- Migration: 20260805000004_create_draft_quota_limits_table.sql

-- btree_gist extension enabled in migration 20260805000000

CREATE TABLE IF NOT EXISTS public.draft_quota_limits (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  hard_ceiling INTEGER NOT NULL
    CHECK (hard_ceiling >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- One limit per org per period start
ALTER TABLE public.draft_quota_limits
  ADD CONSTRAINT draft_quota_limits_org_period_start_unique
  UNIQUE (organization_id, period_start);

-- period_end must be after period_start
ALTER TABLE public.draft_quota_limits
  ADD CONSTRAINT draft_quota_limits_period_end_after_start
  CHECK (period_end > period_start);

-- Prevent overlapping usage periods for the same organization
ALTER TABLE public.draft_quota_limits
  ADD CONSTRAINT draft_quota_limits_no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    daterange(period_start, period_end, '[)') WITH &&
  );

CREATE INDEX idx_draft_quota_limits_org_id ON public.draft_quota_limits(organization_id);
CREATE INDEX idx_draft_quota_limits_period ON public.draft_quota_limits(period_start, period_end);

-- RLS: ENABLED + FORCE, service-role only (operational table)
ALTER TABLE public.draft_quota_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_quota_limits FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_quota_limits TO service_role;
REVOKE ALL ON public.draft_quota_limits FROM authenticated, anon;

-- updated_at trigger
CREATE TRIGGER trigger_draft_quota_limits_updated_at
  BEFORE UPDATE ON public.draft_quota_limits
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();