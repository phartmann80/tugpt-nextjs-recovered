-- Seed Data for TuGPT.ai Local Development
-- File: supabase/seed.sql

-- Insert default system feature flags
--
-- NOTE (2026-08-20): none of the four keys below is read by any code in this
-- repository. The flags actually consulted are `ai_draft_generation` (seeded
-- disabled by migration 20260805000011) and `whatsapp_integration` (no global
-- row at all; is_feature_enabled ANDs the global and org rows inside
-- COALESCE(..., false), so a missing global row resolves to false no matter
-- what an organization sets — asserted as P10 in
-- supabase/tests/database/phase3b_feature_flag_rls.test.sql).
--
-- These rows are inert, and they are deliberately left in place. Do not read
-- `global_whatsapp_integration = true` as the state of the WhatsApp
-- integration: it is not that switch, and it is not any switch. See ADR-010,
-- amendment 2, for where whatsapp_integration is actually enforced — a
-- hardcoded false in packages/feature-flags/src/flags.ts that no database edit
-- can lift.
--
-- This file runs only on `supabase db start` / `supabase db reset` — local
-- development and the CI database-tests job. `supabase db push` does not apply
-- it, so no linked project sees these rows.
INSERT INTO public.feature_flags (id, organization_id, key, is_enabled, rules)
VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'global_whatsapp_integration', true, '{"description": "Global WhatsApp service availability"}'::jsonb),
  ('00000000-0000-0000-0000-000000000002', NULL, 'global_voice_receptionist', true, '{"description": "Global AI Voice Receptionist availability"}'::jsonb),
  ('00000000-0000-0000-0000-000000000003', NULL, 'global_langdock_orchestrator', true, '{"description": "Global Langdock AI Model Provider"}'::jsonb),
  ('00000000-0000-0000-0000-000000000004', NULL, 'global_mastra_orchestrator', true, '{"description": "Global Mastra AI Agent Orchestrator"}'::jsonb)
ON CONFLICT (organization_id, key) DO NOTHING;
