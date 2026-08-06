-- Phase 3B: ai_draft_configs table
-- Migration: 20260805000001_create_ai_draft_configs_table.sql

CREATE TABLE IF NOT EXISTS public.ai_draft_configs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_profile_id UUID NOT NULL,
  business_instructions TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  response_rules TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  max_draft_length INTEGER NOT NULL DEFAULT 1000
    CHECK (max_draft_length BETWEEN 100 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite unique constraint for tenant-consistent FK target
ALTER TABLE public.ai_draft_configs
  ADD CONSTRAINT ai_draft_configs_id_organization_unique
  UNIQUE (id, organization_id);

-- Composite FK: config must belong to the same org as its business profile
ALTER TABLE public.ai_draft_configs
  ADD CONSTRAINT ai_draft_configs_business_profile_org_fk
  FOREIGN KEY (business_profile_id, organization_id)
  REFERENCES public.business_profiles(id, organization_id)
  ON DELETE CASCADE;

-- One config per business profile
ALTER TABLE public.ai_draft_configs
  ADD CONSTRAINT ai_draft_configs_business_profile_unique
  UNIQUE (business_profile_id);

CREATE INDEX idx_ai_draft_configs_org_id ON public.ai_draft_configs(organization_id);
CREATE INDEX idx_ai_draft_configs_business_profile_id ON public.ai_draft_configs(business_profile_id);

-- RLS: enabled, org members can SELECT, owner/admin can INSERT/UPDATE
ALTER TABLE public.ai_draft_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_draft_configs_select
  ON public.ai_draft_configs
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY ai_draft_configs_insert_update
  ON public.ai_draft_configs
  FOR ALL
  TO authenticated
  USING (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- Service-role full access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_draft_configs TO service_role;

-- updated_at trigger
CREATE TRIGGER trigger_ai_draft_configs_updated_at
  BEFORE UPDATE ON public.ai_draft_configs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();