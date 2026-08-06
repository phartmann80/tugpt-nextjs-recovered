-- Phase 3B: draft_generation_jobs table
-- Migration: 20260805000003_create_draft_generation_jobs_table.sql

CREATE TABLE IF NOT EXISTS public.draft_generation_jobs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  source_message_id UUID NOT NULL,
  business_profile_id UUID NOT NULL,
  pgmq_msg_id BIGINT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'skipped', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  skip_reason TEXT,
  error_code TEXT,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite unique constraint for tenant-consistent FK target
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_id_organization_unique
  UNIQUE (id, organization_id);

-- One job per source message
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_org_source_message_unique
  UNIQUE (organization_id, source_message_id);

-- Unique pgmq_msg_id (nullable: null until enqueued)
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_pgmq_msg_id_unique
  UNIQUE (pgmq_msg_id);

-- Composite FK: job must belong to the same org as its conversation
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_conversation_org_fk
  FOREIGN KEY (conversation_id, organization_id)
  REFERENCES public.conversations(id, organization_id)
  ON DELETE CASCADE;

-- Add composite unique constraint on messages for tenant-consistent FK target
-- (already added in migration 002 if it ran first, but ensure it exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_id_organization_unique'
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_id_organization_unique UNIQUE (id, organization_id);
  END IF;
END
$$;

-- Composite FK: job must belong to the same org as its source message
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_source_message_org_fk
  FOREIGN KEY (source_message_id, organization_id)
  REFERENCES public.messages(id, organization_id)
  ON DELETE CASCADE;

-- Composite FK: job must belong to the same org as its business profile
ALTER TABLE public.draft_generation_jobs
  ADD CONSTRAINT draft_generation_jobs_business_profile_org_fk
  FOREIGN KEY (business_profile_id, organization_id)
  REFERENCES public.business_profiles(id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX idx_draft_generation_jobs_org_id ON public.draft_generation_jobs(organization_id);
CREATE INDEX idx_draft_generation_jobs_conversation_id ON public.draft_generation_jobs(conversation_id);
CREATE INDEX idx_draft_generation_jobs_source_message_id ON public.draft_generation_jobs(source_message_id);
CREATE INDEX idx_draft_generation_jobs_status ON public.draft_generation_jobs(status);

-- RLS: ENABLED + FORCE, service-role only (operational table)
ALTER TABLE public.draft_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_generation_jobs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_generation_jobs TO service_role;
REVOKE ALL ON public.draft_generation_jobs FROM authenticated, anon;

-- updated_at trigger
CREATE TRIGGER trigger_draft_generation_jobs_updated_at
  BEFORE UPDATE ON public.draft_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();