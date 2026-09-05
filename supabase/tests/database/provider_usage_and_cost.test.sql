-- provider_usage_and_cost.test.sql
--
-- Token and cost accounting — what a provider call consumed and what it cost.
--
-- Four claims carry the file, and they are the four ways a cost table is
-- normally wrong.
--
-- THE TOTAL IS DEFENSIBLE (T1-T4). An event's cost equals the sum of its
-- components', enforced by a deferred constraint trigger. A total nobody can
-- reconstruct cannot be defended in a billing dispute, and the day it needs
-- defending is a day a customer is already angry. T2 and T3 tamper with each
-- side of the equation and require it to be refused.
--
-- AN UNPRICED CALL IS RECORDED, NOT DROPPED AND NOT FREE (U1-U4). The call
-- already happened and the provider will already charge for it. Raising loses
-- the only evidence it occurred; valuing it at zero under-reports the
-- organization's consumption to the entitlement meter. So it is recorded with
-- a NULL cost, and U3 asserts that NULL is visible as unpriced rather than
-- summed as zero.
--
-- PRICE HISTORY IS IMMUTABLE (P1-P4). The rate is copied onto the component at
-- write time. P4 changes the price afterwards and requires the recorded cost
-- not to move — without which last month's invoice stops reconciling the
-- moment this month's price lands.
--
-- AUDIO BILLS ON THE PROVIDER'S NUMBER, NOT OURS (A1-A3). Gladia defines
-- `billing_time` as `audio_duration * channels`; a stereo file bills twice its
-- length. A2 records a stereo call and asserts the cost follows the billed
-- quantity, not the measured duration — the failure it guards against
-- understates every stereo recording by 100% and surfaces on an invoice.

BEGIN;
SELECT plan(44);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-c057-0000-0000-000000000001', 'member@espiga.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-c057-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-cost-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-c057-0000-0000-000000000001', '11111111-c057-0000-0000-000000000001', 'owner');

-- Rates chosen to make the arithmetic checkable by eye rather than realistic.
--
-- NO gladia FIXTURE. This file used to seed one, and 20260903000004 now seeds
-- the real rate — two rows for (gladia, NULL, audio_seconds) with open-ended
-- ranges, which the GiST exclusion refuses with 23P01. The right resolution is
-- this one rather than narrowing the constraint: the audio assertions below
-- are worth more against the rate the migration actually deploys than against
-- a fixture that merely copies it. If someone fat-fingers the seeded decimal
-- point, A1 and A2 now say so.
INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, source, effective_from)
VALUES
  ('testprov', 'test-model', 'input_tokens',  0.0000100000,
   'fixture: round number, arithmetic checkable by eye', '2020-01-01'),
  ('testprov', 'test-model', 'output_tokens', 0.0000300000,
   'fixture: three times the input rate, so a swap is visible', '2020-01-01');

-- --- S: shape ---------------------------------------------------------------

SELECT has_table('public', 'provider_usage_events', 'S1: events table exists');
SELECT has_table('public', 'provider_usage_components', 'S2: components table exists');
SELECT has_table('public', 'provider_prices', 'S3: price book exists');

SELECT col_is_null('public', 'provider_usage_events', 'cost_micros',
  'S4: cost_micros is NULLABLE — an unpriced call is a real record with an '
  'unknown cost, and NOT NULL would force it to be dropped or valued at zero');

SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider NOT IN ('testprov', 'gladia', 'langdock')),
  0,
  'S5: gladia and langdock are the only real rates the migrations seed — a '
  'wrong price makes cost plausibly wrong, where a missing one makes it '
  'visibly unknown, so every addition here is a deliberate act with a '
  'failing test. This assertion has now caught two such additions'
);

-- Langdock's rates arrived on 2026-09-03 (20260903000005), and with them the
-- second currency. This used to assert that Langdock had NO price, pending
-- confirmation of its per-model rates and its billing currency; both were
-- answered, so the guard becomes a coverage assertion instead of a not-yet
-- one. A model on LANGDOCK_ALLOWED_MODELS with no row here would bill as
-- priced-unknown forever, which is the failure worth pinning.
SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider = 'langdock' AND effective_to IS NULL),
  8,
  'S6: langdock prices all four allowlisted models on both token dimensions'
);

-- --- R: price resolution ----------------------------------------------------

SELECT is(
  private.resolve_provider_price('testprov', 'test-model', 'input_tokens'),
  0.0000100000::numeric,
  'R1: an exact (provider, model) price resolves'
);

SELECT is(
  private.resolve_provider_price('gladia', 'solaria-1', 'audio_seconds'),
  0.0001694444::numeric,
  'R2: a NULL model matches any model — transcription has one rate across '
  'models, and a sentinel like ''*'' would be a model name that can collide'
);

-- A provider-wide rate must not outrank an exact one, or every model on a
-- provider quietly charges the same.
INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, source, effective_from)
VALUES ('testprov', NULL, 'input_tokens', 0.0009900000,
        'fixture: a provider-wide rate that must LOSE to the exact one',
        '2020-01-01');

SELECT is(
  private.resolve_provider_price('testprov', 'test-model', 'input_tokens'),
  0.0000100000::numeric,
  'R3: an exact model price beats a provider-wide one'
);

SELECT is(
  private.resolve_provider_price('testprov', 'other-model', 'input_tokens'),
  0.0009900000::numeric,
  'R3b: and the provider-wide one still applies to a model without its own — '
  'the positive control for R3, which would pass if the fallback never matched'
);

SELECT is(
  private.resolve_provider_price('nobody', 'nothing', 'input_tokens'),
  NULL,
  'R4: an unknown provider resolves to NULL rather than 0'
);

SELECT throws_ok(
  $$INSERT INTO public.provider_prices
      (provider, model, dimension, unit_price, source, effective_from)
    VALUES ('testprov', 'test-model', 'input_tokens', 0.5,
            'fixture: overlapping window, must be refused', '2020-06-01')$$,
  '23P01',
  NULL,
  'R5: two prices for the same key overlapping in time is refused — otherwise '
  'resolution picks one by row order and a call''s cost depends on insert '
  'sequence'
);

-- --- T: the total is defensible ---------------------------------------------

SELECT lives_ok(
  $$SELECT private.record_provider_usage(
      'aaaaaaaa-c057-0000-0000-000000000001', 'text', 'testprov', 'test-model',
      '{"input_tokens": 1200, "output_tokens": 340}'::jsonb,
      'prov-ref-1', 'req-cost-1')$$,
  'T1: a priced text call records'
);

-- 1200 * 0.00001 = 0.012 USD = 12000 µUSD
--  340 * 0.00003 = 0.0102 USD = 10200 µUSD
SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-cost-1'),
  22200::bigint,
  'T1b: and the total is the sum of its parts (12000 + 10200 µUSD)'
);

SELECT is(
  (SELECT count(*)::int FROM public.provider_usage_components c
     JOIN public.provider_usage_events e ON e.id = c.event_id
    WHERE e.request_id = 'req-cost-1'),
  2,
  'T1c: with one component per billed dimension'
);

-- The constraint is DEFERRABLE INITIALLY DEFERRED, because components are
-- inserted after their event and an immediate check would fail on the event's
-- own INSERT. That is correct in production — the invariant is about a set of
-- rows, so it belongs at commit — but it means a tampering UPDATE inside
-- throws_ok returns cleanly and the violation surfaces at COMMIT, which is
-- after the assertion has already passed. Worse, the bad write stays in the
-- transaction and quietly corrupts every later assertion that reads it.
--
-- So the check is forced IMMEDIATE around the tamper assertions. Same trigger,
-- same function, checked at statement time instead of commit time.
SET CONSTRAINTS ALL IMMEDIATE;

SELECT throws_ok(
  $$UPDATE public.provider_usage_events SET cost_micros = 999
     WHERE request_id = 'req-cost-1'$$,
  'P3G02',
  NULL,
  'T2: moving the event total away from its components is refused'
);

SELECT throws_ok(
  $$UPDATE public.provider_usage_components SET cost_micros = 1
     WHERE dimension = 'input_tokens'
       AND event_id = (SELECT id FROM public.provider_usage_events
                        WHERE request_id = 'req-cost-1')$$,
  'P3G02',
  NULL,
  'T3: and moving a component away from the total is refused too — enforcing '
  'one side only leaves the other as the way in'
);

-- The positive control for T2/T3. Without it, a trigger that rejected every
-- write whatsoever would pass both.
SELECT lives_ok(
  $$UPDATE public.provider_usage_events SET request_id = 'req-cost-1b'
     WHERE request_id = 'req-cost-1'$$,
  'T4: an edit that does not touch the arithmetic is allowed — T2/T3 refuse '
  'disagreement, not every write'
);

-- Back to deferred: record_provider_usage REQUIRES it. The function inserts
-- the event with a NULL cost, then its components, then fills the total in —
-- under an immediate check the first of those three statements fails, because
-- at that instant the event has no components at all.
SET CONSTRAINTS ALL DEFERRED;

-- A JSONB object cannot carry a duplicate key, so record_provider_usage can
-- never produce this. The constraint guards a direct write, which is the path
-- a backfill or a repair script takes — and two 'input_tokens' rows on one
-- event is not a richer record, it is a double charge.
SELECT throws_ok(
  $$INSERT INTO public.provider_usage_components
      (event_id, dimension, quantity, unit_price, cost_micros)
    VALUES ((SELECT id FROM public.provider_usage_events
              WHERE request_id = 'req-cost-1b'),
            'input_tokens', 1, 0.00001, 10)$$,
  '23505',
  NULL,
  'T6: a second component for the same dimension on one event is refused'
);

SELECT throws_ok(
  $$SELECT private.record_provider_usage(
      'aaaaaaaa-c057-0000-0000-000000000001', 'text', 'testprov', 'test-model',
      '{}'::jsonb)$$,
  'P3G03',
  NULL,
  'T5: a call with no quantities is refused — an event with no components is a '
  'cost of zero wearing a record''s clothes'
);

-- --- U: unpriced -------------------------------------------------------------

SELECT lives_ok(
  $$SELECT private.record_provider_usage(
      'aaaaaaaa-c057-0000-0000-000000000001', 'text', 'unpriced_prov', 'mystery',
      '{"input_tokens": 500}'::jsonb, NULL, 'req-unpriced')$$,
  'U1: a call with no price still RECORDS — the provider will charge for it '
  'either way, and dropping it destroys the only evidence it happened'
);

SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-unpriced'),
  NULL,
  'U2: with a NULL cost, not a zero'
);

SELECT is(
  (SELECT quantity FROM public.provider_usage_components c
     JOIN public.provider_usage_events e ON e.id = c.event_id
    WHERE e.request_id = 'req-unpriced'),
  500::bigint,
  'U2b: and the quantity is kept, so it can be priced retrospectively once '
  'somebody knows the rate'
);

SELECT is(
  (SELECT count(*)::int FROM public.provider_usage_events
    WHERE organization_id = 'aaaaaaaa-c057-0000-0000-000000000001'
      AND cost_micros IS NULL),
  1,
  'U3: unpriced events are countable — the difference between a known gap and '
  'a wrong number'
);

SET CONSTRAINTS ALL IMMEDIATE;

-- Sets `currency` as well as `cost_micros`, because 20260903000005 added a
-- CHECK that the two are NULL together. Without the currency this UPDATE is
-- refused by that CHECK (23514) before the trigger ever runs — which would
-- still be a refusal, but of a different thing, and would quietly stop this
-- assertion from covering the trigger it was written for.
SELECT throws_ok(
  $$UPDATE public.provider_usage_events SET cost_micros = 0, currency = 'USD'
     WHERE request_id = 'req-unpriced'$$,
  'P3G01',
  NULL,
  'U4: an unpriced event cannot be given a cost while its components have '
  'none — that is exactly the silent zero this design refuses'
);

SET CONSTRAINTS ALL DEFERRED;

-- --- P: price history is immutable ------------------------------------------

SELECT is(
  (SELECT unit_price FROM public.provider_usage_components c
     JOIN public.provider_usage_events e ON e.id = c.event_id
    WHERE e.request_id = 'req-cost-1b' AND c.dimension = 'input_tokens'),
  0.0000100000::numeric,
  'P1: the rate is copied onto the component at write time'
);

-- Close the old rate and open a new one ten times higher.
UPDATE public.provider_prices SET effective_to = pg_catalog.now()
WHERE provider = 'testprov' AND model = 'test-model' AND dimension = 'input_tokens';

INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, source, effective_from)
VALUES ('testprov', 'test-model', 'input_tokens', 0.0001000000,
        'fixture: a later, ten-times-higher rate', pg_catalog.now());

SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-cost-1b'),
  22200::bigint,
  'P2: a price change does not re-price history — otherwise last month''s '
  'invoice stops reconciling the moment this month''s rate lands'
);

SELECT is(
  private.resolve_provider_price('testprov', 'test-model', 'input_tokens'),
  0.0001000000::numeric,
  'P3: while new calls get the new rate — the positive control for P2, which '
  'would pass if the price change had simply not taken'
);

SELECT is(
  private.resolve_provider_price(
    'testprov', 'test-model', 'input_tokens', '2021-01-01'::timestamptz),
  0.0000100000::numeric,
  'P4: and asking as-of a past instant returns the rate that was in force then'
);

-- --- A: audio bills on the provider's number ---------------------------------

-- A mono voice note: 60 seconds, one channel, billing_time = 60.
SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-000000000001', 'audio', 'gladia', 'solaria-1',
  '{"audio_seconds": 60}'::jsonb, 'gladia-job-1', 'req-audio-mono',
  NULL, NULL, '{"audio_duration": 60, "channels": 1}'::jsonb);

-- 60 * 0.0001694444 USD = 0.010166664 USD -> round to 10167 µUSD
SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-audio-mono'),
  10167::bigint,
  'A1: a 60-second mono note costs ~1.02 cents at $0.61/hour'
);

-- The same 60 seconds in STEREO. Gladia's billing_time is
-- audio_duration * number_of_distinct_channels, so this bills 120.
SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-000000000001', 'audio', 'gladia', 'solaria-1',
  '{"audio_seconds": 120}'::jsonb, 'gladia-job-2', 'req-audio-stereo',
  NULL, NULL, '{"audio_duration": 60, "channels": 2}'::jsonb);

SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-audio-stereo'),
  20333::bigint,
  'A2: the SAME 60 seconds of audio in stereo costs twice as much, because '
  'billing_time is duration x channels — a model that stored duration and '
  'multiplied by the rate would understate every stereo file by 100%'
);

SELECT is(
  (SELECT (metadata->>'audio_duration')::int
     FROM public.provider_usage_events WHERE request_id = 'req-audio-stereo'),
  60,
  'A3: and the measured duration is kept beside the billed quantity, so the '
  'difference between the two stays visible instead of being lost'
);

-- --- M: the entitlement meter ------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM public.entitlement_metrics WHERE key = 'ai_cost_micros'),
  1,
  'M1: ai_cost_micros is a declared metric'
);

SELECT is(
  (SELECT kind FROM public.entitlement_metrics WHERE key = 'ai_cost_micros'),
  'meter',
  'M2: and a meter, not a limit — spend accumulates within a period and does '
  'not go down when something is deleted'
);

-- No subscription yet, so no period. A spend meter with no window would be a
-- lifetime total, and comparing a lifetime total against a monthly allowance
-- denies every established customer.
SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c057-0000-0000-000000000001', 'ai_cost_micros'),
  0,
  'M3: with no subscription period, spend reads 0 rather than everything ever'
);

INSERT INTO public.plans (id, key, name)
VALUES ('eeeeeeee-c057-0000-0000-000000000001', 'test_cost', 'Test Cost');

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES ('aaaaaaaa-c057-0000-0000-000000000001',
        'eeeeeeee-c057-0000-0000-000000000001', 'active',
        CURRENT_DATE - 5, CURRENT_DATE + 25);

-- 22200 (text) + 10167 (mono) + 20333 (stereo). The unpriced 500-token call
-- contributes nothing, which is why U3 exists to count it separately.
SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c057-0000-0000-000000000001', 'ai_cost_micros'),
  52700,
  'M4: the meter sums priced spend in the current period'
);

-- An event before the period must not count, or the "monthly" allowance is a
-- lifetime one wearing a period's clothes.
SELECT private.record_provider_usage(
  'aaaaaaaa-c057-0000-0000-000000000001', 'text', 'testprov', 'test-model',
  '{"output_tokens": 1000}'::jsonb, NULL, 'req-old', NULL, NULL, '{}'::jsonb,
  (CURRENT_DATE - 40)::timestamptz);

SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c057-0000-0000-000000000001', 'ai_cost_micros'),
  52700,
  'M5: an event before the period start does not count — the positive control '
  'is M4 having been non-zero, so this is not passing because nothing counts'
);

SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events WHERE request_id = 'req-old'),
  30000::bigint,
  'M5b: even though the old event was itself priced and recorded'
);

-- --- X: access ---------------------------------------------------------------

SELECT table_privs_are('public', 'provider_usage_events', 'authenticated',
  ARRAY[]::text[],
  'X1: authenticated holds nothing on usage events — a row names a provider, a '
  'model and a cost, which is commercial information about how TuGPT is built');

SELECT table_privs_are('public', 'provider_prices', 'authenticated',
  ARRAY[]::text[], 'X2: nor on the price book');

SELECT table_privs_are('public', 'provider_usage_components', 'anon',
  ARRAY[]::text[], 'X3: anon holds nothing');

SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_class
    WHERE oid IN ('public.provider_prices'::regclass,
                  'public.provider_usage_events'::regclass,
                  'public.provider_usage_components'::regclass)
      AND relrowsecurity AND relforcerowsecurity),
  3,
  'X4: all three tables have RLS enabled AND forced'
);

SELECT ok(
  NOT has_function_privilege('authenticated',
    'private.record_provider_usage(uuid,text,text,text,jsonb,text,text,uuid,uuid,jsonb,timestamptz)',
    'EXECUTE'),
  'X5: authenticated cannot record usage — writing this table is how an '
  'organization would edit its own bill'
);

SELECT ok(
  NOT has_function_privilege('authenticated',
    'private.resolve_provider_price(text,text,text,timestamptz)', 'EXECUTE'),
  'X6: nor read the rates'
);

SELECT * FROM finish();
ROLLBACK;
