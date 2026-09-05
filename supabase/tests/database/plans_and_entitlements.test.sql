-- plans_and_entitlements.test.sql
--
-- ADR-015 D5: entitlements are a separate system from feature flags, and this
-- is that system's schema and resolution.
--
-- Three claims carry the file.
--
-- FAIL CLOSED (R1). An organization nobody has subscribed to anything resolves
-- to granted=false, not to unlimited. This is the assertion that decides
-- whether a bug in the signup flow produces a visible failure on the user's
-- first action or an uncapped account discovered on the invoice.
--
-- EVERY DECLARED METRIC IS COUNTABLE (V3). `entitlement_metrics` rows and the
-- branches of `current_entitlement_usage` must be the same set. A metric with
-- no branch is an allowance compared against nothing — it passes every check
-- forever, which is the shape of a limit that silently is not one. V3 walks
-- the table rather than naming the three metrics, so adding a fourth row
-- without a branch fails here rather than in production.
--
-- UNLIMITED AND DENIED ARE DIFFERENT (R7, K4, K5). Both are tempting to store
-- as an integer, and both then collapse: `COALESCE(allowance, 0)` turns
-- unlimited into denied, and a MAXINT sentinel turns denied into unlimited on
-- the first arithmetic. The resolution returns `granted` alongside
-- `allowance` so the two cannot be confused, and these assert they aren't.

BEGIN;
SELECT plan(49);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-e400-0000-0000-000000000001', 'member@espiga.test'),
  ('11111111-e400-0000-0000-000000000002', 'outsider@other.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-e400-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-ent-test'),
  ('aaaaaaaa-e400-0000-0000-000000000002', 'Ferretería El Tornillo', 'tornillo-ent-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-e400-0000-0000-000000000001', '11111111-e400-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-e400-0000-0000-000000000002', '11111111-e400-0000-0000-000000000002', 'owner');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('dddddddd-e400-0000-0000-000000000001', 'aaaaaaaa-e400-0000-0000-000000000001', 'La Espiga');

-- Two active connections and one disconnected, so the whatsapp_numbers metric
-- is tested against a table that contains rows it must NOT count.
INSERT INTO public.whatsapp_connections
  (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES
  ('bbbbbbbb-e400-0000-0000-000000000001', 'aaaaaaaa-e400-0000-0000-000000000001',
   'dddddddd-e400-0000-0000-000000000001', '+593000000001', 'conn-en-1', 'active'),
  ('bbbbbbbb-e400-0000-0000-000000000002', 'aaaaaaaa-e400-0000-0000-000000000001',
   'dddddddd-e400-0000-0000-000000000001', '+593000000002', 'conn-en-2', 'active'),
  ('bbbbbbbb-e400-0000-0000-000000000003', 'aaaaaaaa-e400-0000-0000-000000000001',
   'dddddddd-e400-0000-0000-000000000001', '+593000000003', 'conn-en-3', 'disconnected');

-- --- V: the metric vocabulary ----------------------------------------------

-- The SET, not a count. A count of four says nothing about which four, and
-- the failure it produces ("expected 3, got 4") tells the next person only
-- that a number moved. This names them, so adding one is a deliberate edit
-- here and removing one is loud.
SELECT is(
  (SELECT string_agg(key, ',' ORDER BY key) FROM public.entitlement_metrics),
  'ai_cost_micros,ai_drafts,seats,whatsapp_numbers',
  'V1: exactly the metrics that have a counting branch today, and no others'
);

SELECT throws_ok(
  $$INSERT INTO public.entitlement_metrics (key, kind, unit, description)
    VALUES ('Bad Key', 'limit', 'x', 'y')$$,
  '23514',
  NULL,
  'V2: a malformed metric key is refused by the shape check'
);

SELECT throws_ok(
  $$INSERT INTO public.entitlement_metrics (key, kind, unit, description)
    VALUES ('quota_thing', 'gauge', 'x', 'y')$$,
  '23514',
  NULL,
  'V2b: a kind outside (limit, meter) is refused — the two behave differently '
  'and a third would be counted by nothing'
);

-- The guard. Walks the table rather than naming metrics, so a fourth row
-- added without a branch in current_entitlement_usage fails here.
SELECT lives_ok(
  $$SELECT private.current_entitlement_usage(
      'aaaaaaaa-e400-0000-0000-000000000001', m.key)
    FROM public.entitlement_metrics m$$,
  'V3: every declared metric is countable — entitlement_metrics and the '
  'branches of current_entitlement_usage are the same set'
);

SELECT throws_ok(
  $$SELECT private.current_entitlement_usage(
      'aaaaaaaa-e400-0000-0000-000000000001', 'not_a_metric')$$,
  'P3F02',
  NULL,
  'V4: an uncountable metric raises rather than returning 0 — a metric that '
  'always reads zero is a limit that can never be reached'
);

SELECT throws_ok(
  $$SELECT private.resolve_entitlement(
      'aaaaaaaa-e400-0000-0000-000000000001', 'not_a_metric')$$,
  'P3F01',
  NULL,
  'V5: resolving an unknown metric raises P3F01'
);

-- --- C: the catalogue ships empty ------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM public.plans),
  0,
  'C1: no plans are seeded — allowances are a product decision, and inventing '
  'plausible ones here would put them in the schema as though decided'
);

SELECT is(
  (SELECT count(*)::int FROM public.plan_entitlements),
  0,
  'C2: and nothing is granted'
);

-- --- R: resolution precedence ----------------------------------------------

-- THE assertion. An organization with no subscription is one nobody has
-- decided anything about, and the default for that is no.
SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).granted,
  false,
  'R1: an organization with no subscription is DENIED, not unlimited — a bug '
  'in signup fails on the first action rather than on the invoice'
);

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).source,
  'none',
  'R1b: and says so'
);

INSERT INTO public.plans (id, key, name) VALUES
  ('eeeeeeee-e400-0000-0000-000000000001', 'test_starter', 'Test Starter'),
  ('eeeeeeee-e400-0000-0000-000000000002', 'test_unlimited', 'Test Unlimited');

INSERT INTO public.plan_entitlements (plan_id, metric, allowance) VALUES
  ('eeeeeeee-e400-0000-0000-000000000001', 'seats', 5),
  ('eeeeeeee-e400-0000-0000-000000000001', 'whatsapp_numbers', 2),
  ('eeeeeeee-e400-0000-0000-000000000002', 'seats', NULL);

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES
  ('aaaaaaaa-e400-0000-0000-000000000001', 'eeeeeeee-e400-0000-0000-000000000001',
   'active', CURRENT_DATE - 5, CURRENT_DATE + 25);

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).allowance,
  5,
  'R2: an active subscription resolves from its plan'
);

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).source,
  'plan',
  'R2b: sourced to the plan'
);

-- A metric the plan does not mention is not granted, even though the
-- organization has a subscription. Silence is not permission.
SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'ai_drafts')).granted,
  false,
  'R3: a metric the plan does not mention is not granted — a plan grants what '
  'it lists, not everything it does not forbid'
);

INSERT INTO public.organization_entitlement_overrides
  (organization_id, metric, allowance, reason)
VALUES
  ('aaaaaaaa-e400-0000-0000-000000000001', 'seats', 9,
   'pilot agreement, three extra seats through Q4');

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).allowance,
  9,
  'R4: an override beats the plan'
);

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).source,
  'override',
  'R4b: sourced to the override, so support can see why the number is odd'
);

UPDATE public.organization_entitlement_overrides
SET expires_at = pg_catalog.now() - interval '1 day'
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001' AND metric = 'seats';

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).allowance,
  5,
  'R5: an EXPIRED override falls back to the plan — this is the difference '
  'between a trial that ends and a trial that becomes the price'
);

UPDATE public.organization_entitlement_overrides
SET expires_at = NULL
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001' AND metric = 'seats';

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).allowance,
  9,
  'R5b: and a NULL expiry is permanent, not expired — the positive control '
  'for R5, which would otherwise pass if overrides never resolved at all'
);

DELETE FROM public.organization_entitlement_overrides
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

UPDATE public.organization_subscriptions
SET status = 'past_due'
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).granted,
  true,
  'R6: past_due still resolves — cutting a customer off the hour an invoice '
  'fails is a dunning policy, not a side effect of a status enum'
);

UPDATE public.organization_subscriptions
SET status = 'canceled', canceled_at = pg_catalog.now()
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

SELECT is(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).granted,
  false,
  'R6b: canceled does not resolve'
);

UPDATE public.organization_subscriptions
SET status = 'active', canceled_at = NULL, plan_id = 'eeeeeeee-e400-0000-0000-000000000002'
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

SELECT ok(
  (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).granted
  AND (private.resolve_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats')).allowance IS NULL,
  'R7: unlimited is granted=true with a NULL allowance — distinguishable from '
  'denied, which is granted=false; an INTEGER return would collapse them'
);

-- --- U: what the organization is currently using ---------------------------

SELECT is(
  private.current_entitlement_usage('aaaaaaaa-e400-0000-0000-000000000001', 'seats'),
  1,
  'U1: seats counts organization_members'
);

SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-e400-0000-0000-000000000001', 'whatsapp_numbers'),
  2,
  'U2: whatsapp_numbers counts only active connections — three rows exist, one '
  'disconnected, and a disconnected number is not a number in use'
);

INSERT INTO public.draft_quota_limits (id, organization_id, period_start, period_end, hard_ceiling)
VALUES
  ('ffffffff-e400-0000-0000-000000000001', 'aaaaaaaa-e400-0000-0000-000000000001',
   CURRENT_DATE - 40, CURRENT_DATE - 10, 1000),
  ('ffffffff-e400-0000-0000-000000000002', 'aaaaaaaa-e400-0000-0000-000000000001',
   CURRENT_DATE - 5, CURRENT_DATE + 25, 1000);

INSERT INTO public.draft_usage_tracking
  (organization_id, quota_limit_id, period_start, period_end, draft_count, reserved_count)
VALUES
  ('aaaaaaaa-e400-0000-0000-000000000001', 'ffffffff-e400-0000-0000-000000000001',
   CURRENT_DATE - 40, CURRENT_DATE - 10, 700, 0),
  ('aaaaaaaa-e400-0000-0000-000000000001', 'ffffffff-e400-0000-0000-000000000002',
   CURRENT_DATE - 5, CURRENT_DATE + 25, 12, 3);

SELECT is(
  private.current_entitlement_usage('aaaaaaaa-e400-0000-0000-000000000001', 'ai_drafts'),
  15,
  'U3: the ai_drafts meter reads the CURRENT period only (12+3), not the 700 '
  'from the closed one — summing every period turns a monthly allowance into a '
  'lifetime one and cuts the customer off in month three'
);

-- 15 rather than 12 is the second half of U3: a reservation in flight is
-- consumption that has not landed yet. Excluding it lets two concurrent jobs
-- both see room for the last unit.
SELECT ok(
  private.current_entitlement_usage(
    'aaaaaaaa-e400-0000-0000-000000000001', 'ai_drafts') > 12,
  'U4: in-flight reservations count — excluding them lets two concurrent jobs '
  'both pass a check with one unit left'
);

-- --- K: the question callers actually ask ----------------------------------

UPDATE public.organization_subscriptions
SET plan_id = 'eeeeeeee-e400-0000-0000-000000000001'
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'whatsapp_numbers', 0)).reason,
  'ok',
  'K1: 2 of 2 used with no addition is fine'
);

-- The off-by-one. "Am I under the limit" and "may I add one" are different
-- questions, and answering the first while doing the second is how an
-- organization ends up on number N+1.
SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'whatsapp_numbers', 1)).reason,
  'exceeded',
  'K2: 2 of 2 used, adding one, is REFUSED — check_entitlement answers "may I '
  'consume this", not "am I currently under"'
);

SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats', 1)).reason,
  'ok',
  'K3: 1 of 5 seats used, adding one, is allowed — K2 refuses a real overage, '
  'not everything'
);

SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'ai_drafts', 1)).reason,
  'not_granted',
  'K4: a metric the plan does not grant is refused as not_granted, which is a '
  'different support conversation from exceeded'
);

SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'ai_drafts', 1)).allowed,
  false,
  'K4b: and not allowed'
);

UPDATE public.organization_subscriptions
SET plan_id = 'eeeeeeee-e400-0000-0000-000000000002'
WHERE organization_id = 'aaaaaaaa-e400-0000-0000-000000000001';

SELECT is(
  (private.check_entitlement(
     'aaaaaaaa-e400-0000-0000-000000000001', 'seats', 10000)).reason,
  'unlimited',
  'K5: an unlimited allowance permits any addition, and says why'
);

SELECT throws_ok(
  $$SELECT private.check_entitlement(
      'aaaaaaaa-e400-0000-0000-000000000001', 'seats', -1)$$,
  'P3F03',
  NULL,
  'K6: a negative delta raises — "consuming -1 seats" is a caller bug, and '
  'silently allowing it would let a wrong sign buy headroom'
);

-- --- S: subscription integrity ---------------------------------------------

SELECT throws_ok(
  $$INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
    VALUES ('aaaaaaaa-e400-0000-0000-000000000001',
            'eeeeeeee-e400-0000-0000-000000000001', 'active')$$,
  '23505',
  NULL,
  'S1: two resolving subscriptions for one organization is refused — "which '
  'plan is this customer on" must not have two answers'
);

SELECT lives_ok(
  $$INSERT INTO public.organization_subscriptions
      (organization_id, plan_id, status, canceled_at)
    VALUES ('aaaaaaaa-e400-0000-0000-000000000001',
            'eeeeeeee-e400-0000-0000-000000000001', 'canceled', pg_catalog.now())$$,
  'S2: a canceled subscription may coexist with an active one — S1 constrains '
  'what resolves, not what is remembered'
);

SELECT throws_ok(
  $$INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
    VALUES ('aaaaaaaa-e400-0000-0000-000000000002',
            'eeeeeeee-e400-0000-0000-000000000001', 'canceled')$$,
  '23514',
  NULL,
  'S3: canceled without canceled_at is refused — a cancellation with no date '
  'cannot be reconciled against a bill'
);

SELECT throws_ok(
  $$INSERT INTO public.organization_subscriptions
      (organization_id, plan_id, current_period_start)
    VALUES ('aaaaaaaa-e400-0000-0000-000000000002',
            'eeeeeeee-e400-0000-0000-000000000001', CURRENT_DATE)$$,
  '23514',
  NULL,
  'S4: half a period is refused — an open-ended meter window never rolls'
);

SELECT throws_ok(
  $$DELETE FROM public.plans WHERE key = 'test_starter'$$,
  '23503',
  NULL,
  'S5: a plan with subscriptions cannot be deleted — telling a paying customer '
  'their plan no longer exists is an outage, not a migration'
);

-- --- O: overrides -----------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO public.organization_entitlement_overrides
      (organization_id, metric, allowance, reason)
    VALUES ('aaaaaaaa-e400-0000-0000-000000000002', 'seats', 3, 'x')$$,
  '23514',
  NULL,
  'O1: an override with a one-character reason is refused — six months later '
  'it is indistinguishable from a mistake'
);

SELECT throws_ok(
  $$DELETE FROM public.entitlement_metrics WHERE key = 'seats'$$,
  '23503',
  NULL,
  'O2: a metric that plans still grant cannot be deleted — it would silently '
  'widen every grant to "not granted"'
);

-- --- P: access --------------------------------------------------------------

SELECT table_privs_are('public', 'plans', 'authenticated', ARRAY[]::text[],
  'P1: authenticated holds nothing on plans — the catalogue is platform data');
SELECT table_privs_are('public', 'plan_entitlements', 'authenticated', ARRAY[]::text[],
  'P1b: nor on plan_entitlements');
SELECT table_privs_are('public', 'organization_subscriptions', 'authenticated', ARRAY[]::text[],
  'P1c: nor on organization_subscriptions — this is the table an organization '
  'would most like to edit');
SELECT table_privs_are('public', 'organization_entitlement_overrides', 'authenticated',
  ARRAY[]::text[], 'P1d: nor on the overrides');
SELECT table_privs_are('public', 'entitlement_metrics', 'anon', ARRAY[]::text[],
  'P2: anon holds nothing');

SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_class
    WHERE oid IN ('public.plans'::regclass, 'public.plan_entitlements'::regclass,
                  'public.organization_subscriptions'::regclass,
                  'public.organization_entitlement_overrides'::regclass,
                  'public.entitlement_metrics'::regclass)
      AND relrowsecurity AND relforcerowsecurity),
  5,
  'P3: all five tables have RLS ENABLED and FORCED — without FORCE the owner '
  'bypasses its own policies, and the definer functions run as the owner'
);

SELECT ok(
  NOT has_function_privilege('authenticated',
    'private.resolve_entitlement(uuid,text)', 'EXECUTE'),
  'P4: authenticated cannot resolve directly — resolve_entitlement takes an '
  'organization_id and does not check membership'
);

SELECT ok(
  NOT has_function_privilege('authenticated',
    'private.check_entitlement(uuid,text,integer)', 'EXECUTE'),
  'P4b: nor check_entitlement'
);

SELECT ok(
  has_function_privilege('authenticated',
    'public.organization_entitlements(uuid)', 'EXECUTE'),
  'P5: but the public reader IS callable — it checks membership itself, which '
  'is what makes it the safe one to expose'
);

SELECT set_config('tugpt.test_metric_count',
  (SELECT count(*)::text FROM public.entitlement_metrics), true);

SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-e400-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- Derived rather than hardcoded, so adding a metric does not need this line
-- edited to stay true. It is stashed in a session setting rather than read
-- inline, because by this point the role is `authenticated` and that role
-- genuinely cannot read entitlement_metrics — which is what P1/P2 assert two
-- screens up. A plain subquery here fails with "permission denied", and the
-- suite would be reporting an access-control success as a test failure.
SELECT is(
  (SELECT count(*)::int FROM public.organization_entitlements(
     'aaaaaaaa-e400-0000-0000-000000000001')),
  current_setting('tugpt.test_metric_count')::int,
  'P6: a member gets one row per metric'
);

SELECT throws_ok(
  $$SELECT * FROM public.organization_entitlements(
      'aaaaaaaa-e400-0000-0000-000000000002')$$,
  'P3F04',
  NULL,
  'P7: a non-member is refused — the reader is the tenancy boundary for this '
  'whole subsystem'
);

SET LOCAL ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
