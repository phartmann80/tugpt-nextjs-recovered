-- Phase 3A: Enable RLS on customer-facing tables
-- Migration: 20260804000015_enable_rls_customer_facing_tables.sql

-- business_profiles: already has RLS enabled in migration 001
-- whatsapp_connections: already has RLS enabled in migration 002
-- conversations: already has RLS enabled in migration 005
-- messages: already has RLS enabled in migration 006

-- Grant service_role full access to customer-facing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_connections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO service_role;

-- Grant SELECT to authenticated on customer-facing tables (for org members)
-- INSERT/UPDATE/DELETE is restricted via RLS policies
GRANT SELECT ON public.business_profiles TO authenticated;
GRANT SELECT ON public.whatsapp_connections TO authenticated;
GRANT SELECT ON public.conversations TO authenticated;
GRANT SELECT ON public.messages TO authenticated;

-- Revoke INSERT/UPDATE/DELETE from authenticated on messages
-- Messages can only be created through the service processing RPC
REVOKE INSERT, UPDATE, DELETE ON public.messages FROM authenticated;