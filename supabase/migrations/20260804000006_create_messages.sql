-- Phase 3A: messages table
-- Migration: 20260804000006_create_messages.sql

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  webhook_event_id UUID NOT NULL,
  direction TEXT NOT NULL
    CHECK (direction IN ('inbound', 'outbound')),
  provider_message_id TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'sent', 'delivered', 'read', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Idempotency: one message per webhook event
ALTER TABLE public.messages
  ADD CONSTRAINT messages_webhook_event_id_unique
  UNIQUE (webhook_event_id);

-- Optional scoped constraint
ALTER TABLE public.messages
  ADD CONSTRAINT messages_org_connection_provider_msg_id_unique
  UNIQUE (organization_id, provider_message_id);

-- Length constraints
ALTER TABLE public.messages
  ADD CONSTRAINT messages_provider_message_id_length
  CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 128);

ALTER TABLE public.messages
  ADD CONSTRAINT messages_body_length
  CHECK (body IS NULL OR char_length(body) <= 4096);

-- Composite FK: message must belong to the same org as its conversation
ALTER TABLE public.messages
  ADD CONSTRAINT messages_conversation_org_fk
  FOREIGN KEY (conversation_id, organization_id)
  REFERENCES public.conversations(id, organization_id)
  ON DELETE CASCADE;

-- Composite FK: message must belong to the same org as its webhook receipt
ALTER TABLE public.messages
  ADD CONSTRAINT messages_webhook_event_organization_fk
  FOREIGN KEY (webhook_event_id, organization_id)
  REFERENCES public.webhook_events(id, organization_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX idx_messages_org_id ON public.messages(organization_id);
CREATE INDEX idx_messages_webhook_event_id ON public.messages(webhook_event_id);

-- RLS: enabled, org members can SELECT, service_role can INSERT
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );