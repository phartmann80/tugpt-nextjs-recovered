-- pgTAP tests: M1 Spanish seed defaults for ai_draft_configs
-- File: supabase/tests/database/ai_draft_config_defaults.test.sql
--
-- The thing under test is a set of column defaults, and the temptation is to
-- assert the exact seeded strings. That test would fail on every copy edit and
-- would prove nothing about behaviour, so it is not what these assertions do.
--
-- What they pin is the shape the product depends on:
--
--   * a config created without anyone writing it is in SPANISH, because every
--     organization that exists is (ADR-017), and because an empty default is
--     not neutral — it leaves the model with only the prompt scaffolding to
--     infer a register from;
--   * `business_instructions` stays EMPTY, because it is the one field with no
--     true generic value and a plausible placeholder there would be the
--     product inventing facts about a business;
--   * the backfill did not overwrite text somebody had already written.
--
-- D6 is the one that matters most, and it is the reason the backfill in the
-- migration is conditional rather than unconditional.

BEGIN;
SELECT plan(9);

-- =============================================================================
-- SETUP — two organizations: one seeded from the defaults, one already written
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'Seed Defaults Org', 'm1-seed-defaults'),
  ('cccccccc-0000-0000-0000-000000000002', 'Already Written Org', 'm1-already-written');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-000000000001', 'Seed Defaults'),
  ('cccccccc-0000-0000-0000-0000000000a2', 'cccccccc-0000-0000-0000-000000000002', 'Already Written');

-- Names no column it does not have to: this is the path a config takes when it
-- is created by anything that does not care about language.
INSERT INTO public.ai_draft_configs (organization_id, business_profile_id)
VALUES ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000a1');

INSERT INTO public.ai_draft_configs
  (organization_id, business_profile_id, business_instructions, personality, response_rules, tone)
VALUES (
  'cccccccc-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-0000000000a2',
  'Panadería en La Mariscal. Horario 07:00-19:00.',
  'Muy informal, tuteo.',
  'Nunca ofrezcas entregas el mismo día.',
  'Entusiasta'
);

-- =============================================================================
-- D1–D5 — a config nobody wrote is usable and Spanish
-- =============================================================================
SELECT isnt(
  (SELECT personality FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  '',
  'D1: a config created without naming personality is not empty'
);

SELECT isnt(
  (SELECT tone FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  '',
  'D2: a config created without naming tone is not empty'
);

SELECT isnt(
  (SELECT response_rules FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  '',
  'D3: a config created without naming response_rules is not empty'
);

-- "Is it Spanish" is not decidable in SQL, so this asserts a marker that only
-- survives if the string is: a Spanish-language character the English text it
-- replaced did not contain. Crude, and it fails loudly the day somebody pastes
-- an English default back in, which is the failure worth catching.
SELECT ok(
  (SELECT personality ~ '[áéíóúñ¿¡]' FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  'D4: the seeded personality is Spanish'
);

SELECT ok(
  (SELECT response_rules ~ '[áéíóúñ¿¡]' FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  'D5: the seeded response_rules are Spanish'
);

-- =============================================================================
-- D6 — the field with no true generic value stays empty
-- =============================================================================
SELECT is(
  (SELECT business_instructions FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000001'),
  '',
  'D6: business_instructions has no default — a placeholder there would be an invented fact'
);

-- =============================================================================
-- D7–D9 — a config somebody wrote is left exactly as they wrote it
-- =============================================================================
SELECT is(
  (SELECT personality FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000002'),
  'Muy informal, tuteo.',
  'D7: an explicitly written personality is not replaced by the default'
);

SELECT is(
  (SELECT response_rules FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000002'),
  'Nunca ofrezcas entregas el mismo día.',
  'D8: an explicitly written response_rules is not replaced by the default'
);

SELECT is(
  (SELECT tone FROM public.ai_draft_configs
    WHERE organization_id = 'cccccccc-0000-0000-0000-000000000002'),
  'Entusiasta',
  'D9: an explicitly written tone is not replaced by the default'
);

SELECT finish();
ROLLBACK;
