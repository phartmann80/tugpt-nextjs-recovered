-- Phase 3A: business_profiles table
-- Migration: 20260804000001_create_business_profiles.sql

CREATE TABLE IF NOT EXISTS public.business_profiles (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite unique constraint for tenant-consistent FK targets
ALTER TABLE public.business_profiles
  ADD CONSTRAINT business_profiles_id_organization_unique
  UNIQUE (id, organization_id);

-- One business profile per organization
ALTER TABLE public.business_profiles
  ADD CONSTRAINT business_profiles_organization_unique
  UNIQUE (organization_id);

CREATE INDEX idx_business_profiles_org_id ON public.business_profiles(organization_id);

-- RLS: enabled, org members can SELECT, owner/admin can INSERT/UPDATE
ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_profiles_select
  ON public.business_profiles
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY business_profiles_insert_update
  ON public.business_profiles
  FOR ALL
  TO authenticated
  USING (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );