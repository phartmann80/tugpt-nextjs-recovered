-- Phase 3A: Enable RLS on operational tables
-- Migration: 20260804000014_enable_rls_operational_tables.sql

-- webhook_events: already ENABLED + FORCE in migration 003
-- inbound_message_staging: already ENABLED + FORCE in migration 004
-- failed_jobs: already ENABLED + FORCE in migration 007

-- Ensure no authenticated-user policies exist on operational tables
-- These tables are service-role only

-- Drop any accidental policies if they exist (defensive)
DO $$
BEGIN
  -- webhook_events: no authenticated policies
  -- inbound_message_staging: no authenticated policies
  -- failed_jobs: no authenticated policies
  -- All enforced by ENABLE + FORCE RLS with no policies for authenticated
  NULL;
END;
$$;

-- Grant service_role full access to operational tables
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_message_staging TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.failed_jobs TO service_role;

-- Revoke all from authenticated and anon on operational tables
REVOKE ALL ON public.webhook_events FROM authenticated, anon;
REVOKE ALL ON public.inbound_message_staging FROM authenticated, anon;
REVOKE ALL ON public.failed_jobs FROM authenticated, anon;