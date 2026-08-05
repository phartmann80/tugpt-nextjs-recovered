-- Phase 3A: whatsapp_connections table
-- Migration: 20260804000002_create_whatsapp_connections.sql

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_profile_id UUID NOT NULL REFERENCES public.business_profiles(id) ON DELETE CASCADE,
  display_name TEXT,
  phone_number TEXT NOT NULL,
  provider_phone_number_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disconnected', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Provider identifier length constraint
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_phone_number_id_length
  CHECK (char_length(provider_phone_number_id) BETWEEN 1 AND 128);

-- Unique provider identifier
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_phone_number_id_unique
  UNIQUE (provider_phone_number_id);

-- Composite unique constraint for tenant-consistent FK targets
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_id_organization_unique
  UNIQUE (id, organization_id);

-- Composite FK: connection must belong to the same org as its business profile
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_business_profile_org_fk
  FOREIGN KEY (business_profile_id, organization_id)
  REFERENCES public.business_profiles(id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX idx_whatsapp_connections_org_id ON public.whatsapp_connections(organization_id);
CREATE INDEX idx_whatsapp_connections_provider_phone_number_id ON public.whatsapp_connections(provider_phone_number_id);
CREATE INDEX idx_whatsapp_connections_business_profile_id ON public.whatsapp_connections(business_profile_id);

-- RLS: enabled, org members can SELECT, owner/admin can INSERT/UPDATE
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_connections_select
  ON public.whatsapp_connections
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY whatsapp_connections_insert_update
  ON public.whatsapp_connections
  FOR ALL
  TO authenticated
  USING (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );