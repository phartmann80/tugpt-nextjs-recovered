-- voice_transcription.test.sql
--
-- The flag that keeps Gladia off and the price that makes its cost real
-- (migration 20260903000004).
--
-- Two seeds, no new schema, and yet the failure modes are the expensive kind,
-- so four claims carry the file.
--
-- IT IS OFF, AND OFF IN BOTH DIRECTIONS (F1-F6). A capability that spends
-- money at $0.61 an hour ships disabled. `is_feature_enabled` ANDs a global
-- row with a per-org row, so F4 pins that an organization opting in while the
-- global switch is off stays off (the global row is a master switch, not a
-- default), and F6 pins the converse — flipping the global row must not reach
-- every organization at once. F5 is the positive control for all of them.
--
-- THE RATE IS THE RATE (P1-P6). P4 does not assert the literal that the
-- migration inserted — asserting a constant against itself proves only that
-- copy-paste works. It asserts that the stored per-second rate multiplied by
-- 3600 comes back to USD 0.61, which is the claim a human actually made and
-- the one a fat-fingered decimal place breaks.
--
-- NOT HERE: the cost arithmetic. provider_usage_and_cost.test.sql now runs its
-- audio assertions against this seeded rate rather than a fixture copy of it
-- (its gladia fixture was removed in the same change, because two open-ended
-- rows for the same key are refused by the GiST exclusion). So A1-A3 over
-- there already price a real call at this rate, including the stereo case, and
-- repeating it here would be two tests failing for one reason.
--
-- THE SEED DOES NOT DOUBLE UP (I1-I2). `provider_prices` guards overlapping
-- ranges with a GiST exclusion, which raises rather than skips, so a second
-- run of this migration would abort the deploy rather than quietly duplicate.
-- I1 runs the migration's own INSERT a second time and asserts it is a no-op.
--
-- One mutation survives, recorded rather than papered over: deleting the
-- `WHERE NOT EXISTS` guard from the migration escapes every assertion here.
-- It escapes because a migration runs exactly once against a database, so the
-- guard has no observable effect on a cold build — and the cold build is the
-- only thing CI does. I1 re-runs the statement and so does test the shape, but
-- against its own copy of it, which a mutation to the migration does not
-- touch. Closing that would mean the test reading the migration file at
-- runtime, which trades a real duplication for a fragile relative path. The
-- guard earns its place on re-application (a repaired deploy, a replayed
-- migration set), which is exactly where it cannot be observed from here.

BEGIN;
SELECT plan(14);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1701-0000-0000-000000000001', 'owner@voz.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-1701-0000-0000-000000000001', 'Clínica La Voz', 'voz-transcription-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-1701-0000-0000-000000000001', '11111111-1701-0000-0000-000000000001', 'owner');

-- ===========================================================================
-- F: the flag is real, global, and off
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int FROM public.feature_flags
    WHERE organization_id IS NULL AND key = 'voice_transcription'),
  1,
  'F1: exactly one global voice_transcription flag row exists'
);

SELECT is(
  (SELECT is_enabled FROM public.feature_flags
    WHERE organization_id IS NULL AND key = 'voice_transcription'),
  false,
  'F2: the global flag ships disabled'
);

SELECT is(
  public.is_feature_enabled('aaaaaaaa-1701-0000-0000-000000000001', 'voice_transcription'),
  false,
  'F3: an organization with no row of its own resolves to disabled'
);

-- `is_feature_enabled` ANDs the global row with the per-org row, so the global
-- one is a master switch and not merely a default. That is the property worth
-- pinning: it is what makes "turn transcription off for everyone, now" a
-- single UPDATE rather than one per customer, and it is the reason the global
-- row ships false rather than being absent.
INSERT INTO public.feature_flags (organization_id, key, is_enabled)
VALUES ('aaaaaaaa-1701-0000-0000-000000000001', 'voice_transcription', true);

SELECT is(
  public.is_feature_enabled('aaaaaaaa-1701-0000-0000-000000000001', 'voice_transcription'),
  false,
  'F4: an organization opting in while the global switch is off stays off — '
  'the global row is a master switch, not a default'
);

UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id IS NULL AND key = 'voice_transcription';

-- The positive control for F2, F3 and F4 together. Without it all three would
-- pass against an is_feature_enabled that returned false for everything.
SELECT is(
  public.is_feature_enabled('aaaaaaaa-1701-0000-0000-000000000001', 'voice_transcription'),
  true,
  'F5: both switches on turns it on, so F2-F4 are real observations'
);

-- The other half of the AND: the global switch alone must not enable anybody.
-- A rollout that flipped the global row and reached every organization at once
-- is exactly what the controlled-rollout procedure exists to prevent.
UPDATE public.feature_flags SET is_enabled = false
WHERE organization_id = 'aaaaaaaa-1701-0000-0000-000000000001'
  AND key = 'voice_transcription';

SELECT is(
  public.is_feature_enabled('aaaaaaaa-1701-0000-0000-000000000001', 'voice_transcription'),
  false,
  'F6: the global switch alone enables nobody — enablement stays per-org opt-in'
);

-- ===========================================================================
-- P: the price, and the number a human actually approved
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider = 'gladia' AND dimension = 'audio_seconds' AND effective_to IS NULL),
  1,
  'P1: exactly one current gladia audio price'
);

SELECT ok(
  (SELECT model IS NULL FROM public.provider_prices
    WHERE provider = 'gladia' AND dimension = 'audio_seconds' AND effective_to IS NULL),
  'P2: the price applies to any model, because the endpoint names none'
);

SELECT is(
  (SELECT currency FROM public.provider_prices
    WHERE provider = 'gladia' AND dimension = 'audio_seconds' AND effective_to IS NULL),
  'USD'::bpchar,
  'P3: priced in USD'
);

-- The assertion that would catch a misplaced decimal point. Asserting the
-- inserted literal back would only prove that copy-paste works.
SELECT is(
  round(private.resolve_provider_price('gladia', NULL, 'audio_seconds') * 3600, 4),
  0.6100::numeric,
  'P4: the stored per-second rate is USD 0.61 per hour'
);

SELECT ok(
  (SELECT char_length(source) >= 8 FROM public.provider_prices
    WHERE provider = 'gladia' AND dimension = 'audio_seconds' AND effective_to IS NULL),
  'P5: the price records where the number came from'
);

-- A price is resolvable for a call happening now, not merely present in the
-- table with an effective_from in the future.
SELECT ok(
  private.resolve_provider_price('gladia', NULL, 'audio_seconds') IS NOT NULL,
  'P6: the price resolves at the current time'
);

-- ===========================================================================
-- I: the seed is idempotent
-- ===========================================================================

-- The migration's own statement, run again. `provider_prices` has no unique
-- constraint to conflict on — its guard is a GiST exclusion that raises — so
-- if the WHERE NOT EXISTS were dropped, this would either abort or duplicate.
INSERT INTO public.provider_prices (
  provider, model, dimension, unit_price, currency, effective_from, source
)
SELECT 'gladia', NULL, 'audio_seconds', 0.0001694444, 'USD',
       '2026-09-03T00:00:00Z'::timestamptz, 'rerun of the migration seed'
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_prices
  WHERE provider = 'gladia' AND model IS NULL
    AND dimension = 'audio_seconds' AND effective_to IS NULL
);

SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider = 'gladia' AND dimension = 'audio_seconds'),
  1,
  'I1: re-running the price seed adds nothing'
);

INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES (NULL, 'voice_transcription', false, '{}'::jsonb)
ON CONFLICT DO NOTHING;

SELECT is(
  (SELECT count(*)::int FROM public.feature_flags
    WHERE organization_id IS NULL AND key = 'voice_transcription'),
  1,
  'I2: re-running the flag seed adds nothing'
);

SELECT * FROM finish();
ROLLBACK;
