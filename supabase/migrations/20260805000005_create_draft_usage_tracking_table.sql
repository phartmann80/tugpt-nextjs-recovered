-- Phase 3B: draft_usage_tracking table
-- Migration: 20260805000005_create_draft_usage_tracking_table.sql

CREATE TABLE IF NOT EXISTS public.draft_usage_tracking (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  quota_limit_id UUID NOT NULL REFERENCES public.draft_quota_limits(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  draft_count INTEGER NOT NULL DEFAULT 0
    CHECK (draft_count >= 0),
  reserved_count INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- One tracking row per org per quota limit
CREATE UNIQUE INDEX draft_usage_tracking_org_quota
  ON public.draft_usage_tracking (organization_id, quota_limit_id);

CREATE INDEX idx_draft_usage_tracking_org_id ON public.draft_usage_tracking(organization_id);
CREATE INDEX idx_draft_usage_tracking_quota_limit_id ON public.draft_usage_tracking(quota_limit_id);

-- RLS: ENABLED + FORCE, service-role only (operational table)
ALTER TABLE public.draft_usage_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_usage_tracking FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_usage_tracking TO service_role;
REVOKE ALL ON public.draft_usage_tracking FROM authenticated, anon;

-- updated_at trigger
CREATE TRIGGER trigger_draft_usage_tracking_updated_at
  BEFORE UPDATE ON public.draft_usage_tracking
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();