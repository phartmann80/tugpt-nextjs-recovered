-- Phase 3B: Feature flag global unique index + seed global ai_draft_generation flag
-- Migration: 20260805000011_add_feature_flag_global_unique_index.sql

-- Partial unique index to prevent duplicate global flag rows (where organization_id IS NULL)
-- PostgreSQL treats NULL as distinct in a UNIQUE constraint, so this index is needed
CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_global_key_unique
  ON public.feature_flags (key)
  WHERE organization_id IS NULL;

-- Seed the global ai_draft_generation flag as disabled
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES (NULL, 'ai_draft_generation', false, '{}'::jsonb)
ON CONFLICT DO NOTHING;