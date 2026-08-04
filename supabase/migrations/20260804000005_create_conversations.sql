-- Phase 3A: conversations table
-- Migration: 20260804000005_create_conversations.sql

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL,
  contact_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'needs_human', 'closed')),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Contact phone length constraint
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_contact_phone_length
  CHECK (char_length(contact_phone) BETWEEN 1 AND 32);

-- Unique conversation per org, connection, and contact
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_org_connection_phone_unique
  UNIQUE (organization_id, whatsapp_connection_id, contact_phone);

-- Composite unique constraint for tenant-consistent FK targets
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_id_organization_unique
  UNIQUE (id, organization_id);

-- Composite FK: conversation must belong to the same org as its connection
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_connection_org_fk
  FOREIGN KEY (whatsapp_connection_id, organization_id)
  REFERENCES public.whatsapp_connections(id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX idx_conversations_org_id ON public.conversations(organization_id);
CREATE INDEX idx_conversations_connection_id ON public.conversations(whatsapp_connection_id);
CREATE INDEX idx_conversations_status ON public.conversations(status);

-- RLS: enabled, org members can SELECT, owner/admin/service_role can INSERT/UPDATE
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_select
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY conversations_insert_update
  ON public.conversations
  FOR ALL
  TO authenticated
  USING (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );