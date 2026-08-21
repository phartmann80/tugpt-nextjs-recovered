-- pgTAP tests: Phase 3B feature-flag RLS correction
-- This test supersedes the Phase 3A rls_adversarial.test.sql Test 25 which expected
-- members to be able to read global feature flags. Phase 3B migration 00012 changes
-- the policy so global rows are service-role/platform-only.
-- File: supabase/tests/database/phase3b_feature_flag_rls.test.sql

BEGIN;
SELECT plan(11);

-- Setup: Create test org, members, and feature flags
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','owner@tugpt.ai','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','99999999-9999-9999-9999-999999999999','authenticated','authenticated','nobody@tugpt.ai','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test Org', 'phase3b-ff-org') ON CONFLICT DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Other Org', 'other-ff-org') ON CONFLICT DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner')
ON CONFLICT DO NOTHING;

-- Ensure global flag exists
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES (NULL, 'ai_draft_generation', false, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Ensure org-scoped flag exists for test org
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation', true, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Ensure org-scoped flag exists for other org
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ai_draft_generation', true, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- P1: anon cannot read any feature flags
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_count FROM public.feature_flags;
  EXCEPTION WHEN insufficient_privilege THEN
    v_count := 0;
  END;
  RESET ROLE;
  CREATE TEMP TABLE IF NOT EXISTS _p1 (count INT);
  INSERT INTO _p1 VALUES (v_count);
END;
$$;
SELECT is((SELECT count FROM _p1), 0, 'P1: anon cannot read any feature flags');

-- P1b: anon cannot write feature flags (INSERT blocked by RLS / no policy for anon)
DO $$
DECLARE v_error TEXT := '';
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'anon_write_test', true, '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLSTATE;
  END;
  RESET ROLE;
  CREATE TEMP TABLE IF NOT EXISTS _p1b (error TEXT);
  INSERT INTO _p1b VALUES (v_error);
END;
$$;
SELECT is((SELECT error FROM _p1b), '42501', 'P1b: anon cannot write feature flags (insufficient_privilege)');

-- P2: authenticated user without membership reads none
SELECT set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags),
  0,
  'P2: authenticated user without membership reads none'
);
SET LOCAL ROLE postgres;

-- P3: authenticated member reads own organization rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'P3: authenticated member reads own organization rows'
);
SET LOCAL ROLE postgres;

-- P4: authenticated member cannot read global rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id IS NULL),
  0,
  'P4: authenticated member cannot read global rows'
);
SET LOCAL ROLE postgres;

-- P5: authenticated member cannot read another organization's rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0,
  'P5: authenticated member cannot read another organization rows'
);
SET LOCAL ROLE postgres;

-- P6: owner can update own org-scoped flag
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE public.feature_flags SET is_enabled = true
  WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key = 'ai_draft_generation';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  CREATE TEMP TABLE IF NOT EXISTS _p6 (rows_affected INT);
  INSERT INTO _p6 VALUES (v_rows);
END;
$$;
SET LOCAL ROLE postgres;
SELECT is((SELECT rows_affected FROM _p6), 1, 'P6: owner can update own org-scoped flag');

-- P7: owner cannot modify global rows (RLS blocks, 0 rows affected)
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE public.feature_flags SET is_enabled = true
  WHERE organization_id IS NULL AND key = 'ai_draft_generation';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  CREATE TEMP TABLE IF NOT EXISTS _p7 (rows_affected INT);
  INSERT INTO _p7 VALUES (v_rows);
END;
$$;
SET LOCAL ROLE postgres;
SELECT is((SELECT rows_affected FROM _p7), 0, 'P7: owner cannot modify global rows (RLS blocks, 0 rows affected)');

-- P8: service_role can read and manage the global row
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT count(*)::int INTO v_count FROM public.feature_flags WHERE organization_id IS NULL;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p8 (cnt INT);
  INSERT INTO _p8 VALUES (v_count);
END;
$$;
SELECT is((SELECT cnt FROM _p8) > 0, true, 'P8: service_role can read global rows');

-- =============================================================================
-- P9-P10: both switches ship OFF
--
-- These assert the DEFAULT a fresh database is built with, not the live value
-- in any deployed environment — turning a flag on in staging is a database edit
-- that never touches this repository, and nothing here would notice it. What
-- they guard is the repository: a migration or seed that ships either switch in
-- the on position fails CI.
--
-- For whatsapp_integration that is the point. Flipping it is meant to be a
-- deliberate code change with owner approval, never a quiet default.
-- =============================================================================

SELECT is(
  (SELECT is_enabled FROM public.feature_flags
   WHERE organization_id IS NULL AND key = 'ai_draft_generation'),
  false,
  'P9: the global ai_draft_generation row exists and ships disabled (20260805000011)'
);

-- whatsapp_integration has no global row at all, and is safe because of it:
-- is_feature_enabled ANDs the global row with the org row inside
-- COALESCE(..., false), so a missing global row resolves to false no matter
-- what an organization sets. That is worth proving rather than reasoning about,
-- because it is the behaviour a global row set to `true` would silently undo.
-- The org row below is deliberately `true`; the answer must still be false.
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'whatsapp_integration', true, '{}'::jsonb)
ON CONFLICT DO NOTHING;

SELECT is(
  public.is_feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'whatsapp_integration'),
  false,
  'P10: whatsapp_integration resolves false even for an org that set its own row true'
);

SELECT finish();
ROLLBACK;
