-- Phase 3A: inbound_message_staging table (SERVER-ONLY, NARROW COLUMNS)
-- Migration: 20260804000004_create_inbound_message_staging.sql

CREATE TABLE IF NOT EXISTS public.inbound_message_staging (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  webhook_event_id UUID NOT NULL REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  contact_identifier TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  body_text TEXT,
  provider_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- One staging row per webhook event
ALTER TABLE public.inbound_message_staging
  ADD CONSTRAINT inbound_message_staging_webhook_event_id_unique
  UNIQUE (webhook_event_id);

CREATE INDEX idx_inbound_message_staging_webhook_event_id ON public.inbound_message_staging(webhook_event_id);

-- RLS: ENABLED + FORCE, NO authenticated-user policies. Service-role only.
ALTER TABLE public.inbound_message_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_message_staging FORCE ROW LEVEL SECURITY;