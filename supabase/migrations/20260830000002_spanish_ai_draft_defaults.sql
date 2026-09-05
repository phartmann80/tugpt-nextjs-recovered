-- M1: Spanish seed defaults for ai_draft_configs
-- Migration: 20260830000002_spanish_ai_draft_defaults.sql
--
-- WHY THIS EXISTS
--
-- `ai_draft_configs` has defaulted every text column to '' since
-- 20260805000001. An organization created without anyone writing its config
-- therefore reaches the model with no personality, no tone and no rules — the
-- exact state the supervised flip on 2026-08-30 produced evidence about. Asked
-- for opening hours and prices it had never been given, the unconstrained
-- configuration invented both, including a $300-$800 range for a bakery.
--
-- TuGPT is sold in Ecuador and every organization that exists is Spanish. An
-- empty default is not neutral here; it is English-by-omission, because it
-- leaves the model with nothing but the prompt scaffolding to infer a register
-- from.
--
-- WHAT IT CHANGES
--
--   1. personality, response_rules and tone get Spanish defaults.
--   2. Existing rows still holding '' in those columns are backfilled.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
-- `business_instructions` keeps its empty default. There is nothing true to put
-- there: it is the one column that must describe a specific business, and
-- seeding it with plausible-sounding text would be the product committing the
-- fabrication this whole change exists to prevent.
--
-- It also does not seed the anti-invention rule into `response_rules`. That
-- rule is now emitted for every draft by
-- `packages/ai-orchestration/src/prompt-builder.ts`, appended after all
-- per-organization text, so no config edit can remove it. A seeded copy would
-- be a second, deletable statement of a rule the system already guarantees —
-- and the first time the two disagreed, the config's copy would be the one an
-- owner believed. `response_rules` seeds the parts an owner SHOULD edit.
--
-- The backfill touches only rows that are still exactly ''. A configuration
-- someone has written — including the pilot organization armed on 2026-08-30 —
-- is left alone. A migration is not a place to overwrite someone's text.

-- =============================================================================
-- 1. Defaults for new rows
-- =============================================================================

ALTER TABLE public.ai_draft_configs
  ALTER COLUMN personality SET DEFAULT
    'Cercano y profesional. Trato de usted. Español neutro, sin modismos de otros países.';

ALTER TABLE public.ai_draft_configs
  ALTER COLUMN tone SET DEFAULT 'Amable';

ALTER TABLE public.ai_draft_configs
  ALTER COLUMN response_rules SET DEFAULT
    'Saluda por el nombre del negocio. '
    'Responde de forma breve y concreta; una sola pregunta a la vez. '
    'Si el cliente pide algo que el negocio sí ofrece, confirma los detalles que '
    'necesitas para atenderlo (fecha, cantidad, forma de entrega). '
    'Despídete ofreciendo ayuda para el siguiente paso.';

COMMENT ON COLUMN public.ai_draft_configs.response_rules IS
  'Per-organization response guidance, in the organization''s own words. NOT '
  'the place for the anti-invention guardrail: that is emitted unconditionally '
  'by prompt-builder.ts after every per-organization section, so it cannot be '
  'edited away. See ADR-017 and the 2026-08-30 flip evidence.';

COMMENT ON COLUMN public.ai_draft_configs.business_instructions IS
  'What this specific business does, sells, and when. Intentionally has no '
  'default: it is the one field with no true generic value, and a plausible '
  'placeholder here would be the product inventing facts about a business.';

-- =============================================================================
-- 2. Backfill, and only where nothing was written
-- =============================================================================

UPDATE public.ai_draft_configs
   SET personality =
         'Cercano y profesional. Trato de usted. Español neutro, sin modismos de otros países.'
 WHERE personality = '';

UPDATE public.ai_draft_configs
   SET tone = 'Amable'
 WHERE tone = '';

UPDATE public.ai_draft_configs
   SET response_rules =
         'Saluda por el nombre del negocio. '
         'Responde de forma breve y concreta; una sola pregunta a la vez. '
         'Si el cliente pide algo que el negocio sí ofrece, confirma los detalles que '
         'necesitas para atenderlo (fecha, cantidad, forma de entrega). '
         'Despídete ofreciendo ayuda para el siguiente paso.'
 WHERE response_rules = '';
