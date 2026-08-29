-- pgTAP tests: M0 draft quota period lifecycle
-- File: supabase/tests/database/draft_quota_period_lifecycle.test.sql
--
-- The guard under test says: `ai_draft_generation` cannot be turned on for an
-- organization that has no draft_quota_limits row covering today.
--
-- A guard like that is worthless if it can only be observed passing. On a CI
-- database no organization has the flag enabled, so an invariant scan would go
-- green while enforcing nothing. Q1 is therefore a POSITIVE CONTROL: it makes
-- the forbidden thing happen and asserts the specific SQLSTATE. Everything
-- after it is only meaningful because Q1 proved the guard can fail.
--
-- Q17 and Q18 are the other half of that: they prove the guard is *scoped*.
-- A check that refused every flag write would also pass Q1 while breaking the
-- product, so the exemptions are tested as deliberately as the rule.

BEGIN;
SELECT plan(21);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Quota Org A', 'm0-quota-org-a'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Quota Org B', 'm0-quota-org-b'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Quota Org C', 'm0-quota-org-c'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Quota Org D', 'm0-quota-org-d');

-- The global row is seeded false by 20260805000011. Assert that starting point
-- rather than assuming it: every "effective is false" test below depends on it.
UPDATE public.feature_flags SET is_enabled = false
WHERE organization_id IS NULL AND key = 'ai_draft_generation';

-- =============================================================================
-- Q1 — POSITIVE CONTROL. Without this the rest of the file proves nothing.
-- =============================================================================
SELECT throws_ok(
  $$INSERT INTO public.feature_flags (organization_id, key, is_enabled)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'ai_draft_generation', true)$$,
  'P3B17',
  'DRAFT_QUOTA_PERIOD_REQUIRED',
  'Q1: enabling ai_draft_generation for an org with no covering quota period raises P3B17'
);

SELECT is(
  (SELECT count(*)::INT FROM public.feature_flags
   WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND key = 'ai_draft_generation'),
  0,
  'Q2: the refused insert left no flag row behind'
);

-- =============================================================================
-- ensure_draft_quota_period
-- =============================================================================
CREATE TEMP TABLE _q_first AS
SELECT * FROM public.ensure_draft_quota_period('aaaaaaaa-0000-0000-0000-000000000001', 500);

SELECT is(
  (SELECT created FROM _q_first),
  true,
  'Q3: first call creates a period'
);

SELECT ok(
  (SELECT CURRENT_DATE >= period_start AND CURRENT_DATE < period_end FROM _q_first),
  'Q4: the created period covers today'
);

SELECT is(
  (SELECT period_start FROM _q_first),
  date_trunc('month', CURRENT_DATE)::DATE,
  'Q5: period_start is the first of the current month'
);

SELECT is(
  (SELECT period_end FROM _q_first),
  (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE,
  'Q6: period_end is the first of next month (half-open)'
);

CREATE TEMP TABLE _q_second AS
SELECT * FROM public.ensure_draft_quota_period('aaaaaaaa-0000-0000-0000-000000000001', 999);

SELECT is(
  (SELECT created FROM _q_second),
  false,
  'Q7: second call does not create — idempotent, and no exclusion-constraint error'
);

SELECT is(
  (SELECT quota_limit_id FROM _q_second),
  (SELECT quota_limit_id FROM _q_first),
  'Q8: second call returns the same row'
);

SELECT is(
  (SELECT hard_ceiling FROM _q_second),
  500,
  'Q9: an existing live period is NOT silently re-ceilinged by a different argument'
);

-- =============================================================================
-- With quota in place, the guard stops objecting
-- =============================================================================
SELECT lives_ok(
  $$INSERT INTO public.feature_flags (organization_id, key, is_enabled)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'ai_draft_generation', true)$$,
  'Q10: once a covering period exists, enabling the flag succeeds'
);

-- =============================================================================
-- enable_draft_generation_for_org — the sanctioned path
-- =============================================================================
CREATE TEMP TABLE _q_enable AS
SELECT * FROM public.enable_draft_generation_for_org('aaaaaaaa-0000-0000-0000-000000000002', 250);

SELECT is(
  (SELECT org_flag_enabled FROM _q_enable),
  true,
  'Q11: enable_draft_generation_for_org sets the org flag'
);

SELECT is(
  (SELECT quota_created FROM _q_enable),
  true,
  'Q12: ...and created the quota period in the same call'
);

-- The property that keeps the owner in control.
SELECT is(
  (SELECT effective FROM _q_enable),
  false,
  'Q13: effective is FALSE while the global row is false — preparing an org starts nothing'
);

SELECT is(
  public.is_feature_enabled('aaaaaaaa-0000-0000-0000-000000000002', 'ai_draft_generation'),
  false,
  'Q14: is_feature_enabled agrees — the global AND still gates it'
);

-- =============================================================================
-- The global row is exempt from the guard (it is the supervised switch)
-- =============================================================================
SELECT lives_ok(
  $$UPDATE public.feature_flags SET is_enabled = true
    WHERE organization_id IS NULL AND key = 'ai_draft_generation'$$,
  'Q15: the global row can be flipped without any org quota check'
);

SELECT is(
  public.is_feature_enabled('aaaaaaaa-0000-0000-0000-000000000002', 'ai_draft_generation'),
  true,
  'Q16: with global true AND org true, the feature resolves enabled'
);

-- =============================================================================
-- Scope: the guard must not become a check on every flag write
-- =============================================================================
SELECT lives_ok(
  $$INSERT INTO public.feature_flags (organization_id, key, is_enabled)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000003', 'whatsapp_integration', true)$$,
  'Q17: a different flag key is unaffected — no quota required'
);

-- A period that lapses must not turn unrelated edits into errors. Simulate the
-- month rolling over by removing the covering row from an already-enabled org.
DELETE FROM public.draft_quota_limits
WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000002';

SELECT lives_ok(
  $$UPDATE public.feature_flags SET rules = '{"note":"unrelated edit"}'::jsonb
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000002'
      AND key = 'ai_draft_generation'$$,
  'Q18: an already-enabled row still accepts edits after its period lapses (reserve_draft_usage owns that case)'
);

-- =============================================================================
-- disable_draft_generation_for_org — the rollback path
-- =============================================================================
SELECT is(
  (SELECT effective FROM public.disable_draft_generation_for_org('aaaaaaaa-0000-0000-0000-000000000001')),
  false,
  'Q19: disable turns the feature off for that org'
);

SELECT is(
  (SELECT count(*)::INT FROM public.draft_quota_limits
   WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1,
  'Q20: disable leaves the quota row intact — the pilot usage record survives rollback'
);

-- =============================================================================
-- Argument validation
-- =============================================================================
SELECT throws_ok(
  $$SELECT * FROM public.enable_draft_generation_for_org('aaaaaaaa-0000-0000-0000-00000000dead', 100)$$,
  'P3B17',
  'ORGANIZATION_NOT_FOUND',
  'Q21: an unknown organization is refused before anything is written'
);

SELECT finish();
ROLLBACK;
