-- Phase 3B: ai_drafts table (WITHOUT current_revision_id, added in migration 008)
-- Migration: 20260805000002_create_ai_drafts_table.sql

CREATE TABLE IF NOT EXISTS public.ai_drafts (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_profile_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  source_message_id UUID NOT NULL,
  current_revision_id UUID,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Composite unique constraints for tenant-consistent FK targets
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_id_organization_unique
  UNIQUE (id, organization_id);

-- One draft per inbound source message
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_org_source_message_unique
  UNIQUE (organization_id, source_message_id);

-- Composite FK: draft must belong to the same org as its business profile
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_business_profile_org_fk
  FOREIGN KEY (business_profile_id, organization_id)
  REFERENCES public.business_profiles(id, organization_id)
  ON DELETE CASCADE;

-- Composite FK: draft must belong to the same org as its conversation
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_conversation_org_fk
  FOREIGN KEY (conversation_id, organization_id)
  REFERENCES public.conversations(id, organization_id)
  ON DELETE RESTRICT;

-- Add composite unique constraint on messages for tenant-consistent FK target
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_id_organization_unique'
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_id_organization_unique UNIQUE (id, organization_id);
  END IF;
END
$$;

-- Composite FK: draft must belong to the same org as its source message
ALTER TABLE public.ai_drafts
  ADD CONSTRAINT ai_drafts_source_message_org_fk
  FOREIGN KEY (source_message_id, organization_id)
  REFERENCES public.messages(id, organization_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_ai_drafts_org_id ON public.ai_drafts(organization_id);
CREATE INDEX idx_ai_drafts_conversation_id ON public.ai_drafts(conversation_id);
CREATE INDEX idx_ai_drafts_source_message_id ON public.ai_drafts(source_message_id);
CREATE INDEX idx_ai_drafts_status ON public.ai_drafts(status);

-- RLS: enabled, org members can SELECT, service_role only for INSERT/UPDATE/DELETE
ALTER TABLE public.ai_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_drafts_select
  ON public.ai_drafts
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

-- Service-role full access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_drafts TO service_role;
GRANT SELECT ON public.ai_drafts TO authenticated;

-- updated_at trigger
CREATE TRIGGER trigger_ai_drafts_updated_at
  BEFORE UPDATE ON public.ai_drafts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();