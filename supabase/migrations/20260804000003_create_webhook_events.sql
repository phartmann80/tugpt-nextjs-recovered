-- Phase 3A: webhook_events table (METADATA-ONLY)
-- Migration: 20260804000003_create_webhook_events.sql

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL,
  whatsapp_connection_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'meta',
  provider_event_key TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  processed_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL OR last_error_code IN (
        'DB_TRANSIENT', 'STAGING_NOT_FOUND', 'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND'
      )
    )
);

-- Length constraints
ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_provider_event_key_length
  CHECK (char_length(provider_event_key) BETWEEN 1 AND 128);

ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_payload_sha256_format
  CHECK (char_length(payload_sha256) = 64 AND payload_sha256 ~ '^[0-9a-f]{64}$');

-- Deduplication: unique per provider, connection, and event key
ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_provider_connection_event_key_unique
  UNIQUE (provider, whatsapp_connection_id, provider_event_key);

-- Composite unique constraint for tenant-consistent FK targets
ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_id_organization_unique
  UNIQUE (id, organization_id);

-- Composite FK: receipt must belong to the same org as its connection
ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_connection_org_fk
  FOREIGN KEY (whatsapp_connection_id, organization_id)
  REFERENCES public.whatsapp_connections(id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX idx_webhook_events_org_id ON public.webhook_events(organization_id);
CREATE INDEX idx_webhook_events_connection_id ON public.webhook_events(whatsapp_connection_id);
CREATE INDEX idx_webhook_events_status ON public.webhook_events(status);

-- RLS: ENABLED + FORCE, NO authenticated-user policies. Service-role only.
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;