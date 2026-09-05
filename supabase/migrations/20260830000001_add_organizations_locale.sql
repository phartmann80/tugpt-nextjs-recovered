-- M1: organization locale
-- Migration: 20260830000001_add_organizations_locale.sql
--
-- WHY THIS EXISTS
--
-- The dashboard has to render in one language, and something has to decide
-- which. The decision recorded in ADR-017 is that the language is a property
-- of the *business*, not of whoever opened the tab: a bakery in Quito wants a
-- Spanish dashboard for every one of its reviewers, including the one whose
-- laptop is set to English. Browser detection would give that reviewer an
-- English screen and the owner beside them a Spanish one, looking at the same
-- draft.
--
-- WHAT IT ADDS
--
--   1. public.organizations.locale — NOT NULL, DEFAULT 'es', CHECK ('es','en')
--   2. The same CHECK on the existing public.profiles.preferred_locale
--
-- ON (2): that column has existed since 20260716000001 with no constraint and
-- no reader, while `packages/database/src/types.ts` has typed it as
-- `'es' | 'en'` the whole time. The type was a claim the database did not
-- enforce, which is the kind of thing that reads as safe right up until
-- something writes 'pt-BR' into it. This migration makes the claim true. It
-- does NOT make the column a reader: locale resolution goes through
-- `organizations.locale` only, and a per-user override is a separate decision
-- nobody has taken yet.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
-- It does not change `create_organization_with_owner`. New organizations get
-- 'es' from the column default, which is the value that RPC would have passed
-- anyway; adding a parameter would change a granted RPC signature to express
-- something the default already expresses. When an English organization is
-- created it will be an UPDATE, and that is fine at the volume we create
-- organizations by hand.

-- =============================================================================
-- 0. Pre-flight: fail comprehensibly rather than with a bare 23514
-- =============================================================================
--
-- Nothing writes preferred_locale today, so every row should already be 'es'.
-- If that is wrong, the interesting information is *which* values are in there,
-- and a raw check_violation does not carry it.

DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(DISTINCT quote_literal(preferred_locale), ', ')
    INTO offenders
    FROM public.profiles
   WHERE preferred_locale NOT IN ('es', 'en');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'public.profiles.preferred_locale holds values outside (es, en): %. '
      'Nothing in the codebase writes this column, so these arrived some other '
      'way and are worth understanding before they are constrained away.',
      offenders;
  END IF;
END $$;

-- =============================================================================
-- 1. organizations.locale
-- =============================================================================
--
-- NOT NULL with a default, so this is a metadata-only change on PostgreSQL 11+
-- and every existing organization becomes Spanish without a table rewrite.
-- Spanish is the right backfill and not merely the convenient one: every
-- organization that exists today is a staging or pilot org for the Ecuador
-- launch.

ALTER TABLE public.organizations
  ADD COLUMN locale TEXT NOT NULL DEFAULT 'es';

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_locale_supported
  CHECK (locale IN ('es', 'en'));

COMMENT ON COLUMN public.organizations.locale IS
  'Language the dashboard renders in for this organization. A property of the '
  'business, not of the browser — see ADR-017. Kept in step with '
  'ORGANIZATION_LOCALES in packages/database/src/locales.ts and with the '
  'dictionaries in apps/web/src/i18n; the dictionary parity test fails if a '
  'locale is added here and nowhere else.';

-- =============================================================================
-- 2. profiles.preferred_locale — constrain what the types already assert
-- =============================================================================

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_preferred_locale_supported
  CHECK (preferred_locale IN ('es', 'en'));

COMMENT ON COLUMN public.profiles.preferred_locale IS
  'Reserved for a future per-user language override. NOT read by anything '
  'today: locale resolution uses organizations.locale (ADR-017). Constrained '
  'in 20260830000001 so the column matches the type that has always described '
  'it.';
