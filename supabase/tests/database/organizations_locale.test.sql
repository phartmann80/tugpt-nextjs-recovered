-- pgTAP tests: M1 organization locale
-- File: supabase/tests/database/organizations_locale.test.sql
--
-- What is under test is a column and two CHECK constraints, which is the kind
-- of thing that gets tested by asserting it exists and nothing else. Existence
-- is the least interesting property here. The three that matter are:
--
--   * the default is Spanish, because every code path that does not care about
--     language depends on getting Spanish without asking (ADR-017);
--   * the constraint actually refuses an unsupported locale, because the whole
--     reason it exists is that `packages/database/src/types.ts` has claimed
--     since July that this vocabulary is closed;
--   * the constraint does NOT refuse 'en', because a check that rejected
--     everything would satisfy the previous point while breaking the product.
--
-- L4 and L8 are that third case. They are the reason this file is worth more
-- than a `has_column` call.

BEGIN;
SELECT plan(10);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Locale Org Default', 'm1-locale-default'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Locale Org English', 'm1-locale-english');

UPDATE public.organizations
   SET locale = 'en'
 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002';

-- A real profile row for L8–L10. Created through auth.users so the
-- handle_new_user trigger writes the profile the way a signup does, rather
-- than inserting into public.profiles and stepping around the foreign key.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change
) VALUES (
  '00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-0000000000ff',
  'authenticated', 'authenticated', 'locale-probe@example.com', '', '2026-01-01 00:00:00',
  '2026-01-01 00:00:00', '2026-01-01 00:00:00', '{}', '{}', false, '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- L1–L3 — the column, and the shape the application relies on
-- =============================================================================
SELECT has_column('public', 'organizations', 'locale', 'L1: organizations has a locale column');

SELECT col_not_null(
  'public', 'organizations', 'locale',
  'L2: organizations.locale is NOT NULL — resolution never has to handle a null'
);

SELECT is(
  (SELECT locale FROM public.organizations
    WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  'es',
  'L3: an organization created without naming a locale is Spanish'
);

-- =============================================================================
-- L4–L5 — the constraint is scoped, not blanket
-- =============================================================================
SELECT is(
  (SELECT locale FROM public.organizations
    WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  'en',
  'L4: an organization can be set to English'
);

SELECT throws_ok(
  $$UPDATE public.organizations SET locale = 'pt'
     WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  'L5: a locale outside the supported set is refused'
);

SELECT is(
  (SELECT locale FROM public.organizations
    WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  'es',
  'L6: the refused update left the row unchanged'
);

-- Case matters. 'ES' is not a locale this product has a dictionary for, and a
-- case-insensitive constraint would let one in and then fail to find it.
SELECT throws_ok(
  $$INSERT INTO public.organizations (name, slug, locale)
    VALUES ('Locale Org Shouty', 'm1-locale-shouty', 'ES')$$,
  '23514',
  NULL,
  'L7: locale is case-sensitive — ES is not es'
);

-- =============================================================================
-- L8–L10 — profiles.preferred_locale, constrained but still unread
-- =============================================================================
--
-- This column has no reader (see the migration header). It is tested here
-- because an unenforced column that TypeScript describes as a closed union is
-- exactly the kind of quiet mismatch that is only discovered by the row that
-- breaks something downstream.

SELECT is(
  (SELECT preferred_locale FROM public.profiles
    WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000ff'),
  'es',
  'L8: a new profile is Spanish by default'
);

SELECT lives_ok(
  $$UPDATE public.profiles SET preferred_locale = 'en'
     WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000ff'$$,
  'L9: the profiles constraint permits en'
);

SELECT throws_ok(
  $$UPDATE public.profiles SET preferred_locale = 'fr'
     WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000ff'$$,
  '23514',
  NULL,
  'L10: profiles.preferred_locale refuses an unsupported locale'
);

SELECT finish();
ROLLBACK;
