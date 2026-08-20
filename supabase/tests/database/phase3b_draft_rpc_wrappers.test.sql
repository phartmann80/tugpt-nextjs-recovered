-- Phase 3B Stage 4A: pgTAP tests for public draft RPC wrappers
-- Tests permission and behavior of the public service-role-only wrappers
-- around private draft generation RPCs.
--
-- REWRITTEN 2026-08-20, when this suite was first wired into CI. Two defects
-- that only an actual run could surface:
--
--   1. Twelve of the sixteen planned "tests" were bare selects of the form
--        SELECT NOT has_function_privilege(...) AS ok_2, '...' AS test_name;
--      which emit a result set, not TAP. pg_prove ignores them, so they could
--      never fail and never counted toward the plan — the file planned 16 and
--      emitted 8. Every one is now a real assertion.
--   2. `finish()` was missing, so the plan-versus-ran mismatch was never even
--      reported.
--
-- The archive signatures below are the four-argument forms introduced by
-- 20260819000001, which DROPped the three-argument versions. The two
-- hasnt_function assertions guard that drop: the migration's stated intent was
-- to leave no callable three-argument overload behind.

BEGIN;

-- Plan: 22 tests
SELECT plan(22);

-- =============================================================================
-- Permission tests: wrappers must be service_role only
-- =============================================================================

-- reserve_draft_usage wrapper
SELECT has_function(
  'public', 'reserve_draft_usage',
  ARRAY['uuid'],
  'public.reserve_draft_usage wrapper exists'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.reserve_draft_usage(uuid)', 'EXECUTE'),
  'anon cannot execute public.reserve_draft_usage'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.reserve_draft_usage(uuid)', 'EXECUTE'),
  'authenticated cannot execute public.reserve_draft_usage'
);

SELECT ok(
  has_function_privilege('service_role', 'public.reserve_draft_usage(uuid)', 'EXECUTE'),
  'service_role can execute public.reserve_draft_usage'
);

-- store_draft wrapper
SELECT has_function(
  'public', 'store_draft',
  ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text'],
  'public.store_draft wrapper exists'
);

SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
  ),
  'anon cannot execute public.store_draft'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
  ),
  'authenticated cannot execute public.store_draft'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
  ),
  'service_role can execute public.store_draft'
);

-- archive_draft_failed_job wrapper (four-argument form, 20260819000001)
SELECT has_function(
  'public', 'archive_draft_failed_job',
  ARRAY['bigint', 'uuid', 'text', 'text'],
  'public.archive_draft_failed_job wrapper exists with the provider-detail parameter'
);

SELECT hasnt_function(
  'public', 'archive_draft_failed_job',
  ARRAY['bigint', 'uuid', 'text'],
  'the three-argument public.archive_draft_failed_job overload is gone, not shadowed'
);

SELECT hasnt_function(
  'private', 'archive_draft_failed_job',
  ARRAY['bigint', 'uuid', 'text'],
  'the three-argument private.archive_draft_failed_job overload is gone, not shadowed'
);

SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.archive_draft_failed_job(bigint, uuid, text, text)', 'EXECUTE'
  ),
  'anon cannot execute public.archive_draft_failed_job'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.archive_draft_failed_job(bigint, uuid, text, text)', 'EXECUTE'
  ),
  'authenticated cannot execute public.archive_draft_failed_job'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.archive_draft_failed_job(bigint, uuid, text, text)', 'EXECUTE'
  ),
  'service_role can execute public.archive_draft_failed_job'
);

-- skip_draft_job wrapper
SELECT has_function(
  'public', 'skip_draft_job',
  ARRAY['uuid', 'bigint', 'text'],
  'public.skip_draft_job wrapper exists'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'),
  'anon cannot execute public.skip_draft_job'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'
  ),
  'authenticated cannot execute public.skip_draft_job'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'
  ),
  'service_role can execute public.skip_draft_job'
);

-- =============================================================================
-- Behavior tests: wrappers delegate to private functions
-- =============================================================================

-- Test: reserve_draft_usage returns DENIED for non-existent job
SELECT results_eq(
  $$
    SELECT status::text, reason::text
    FROM public.reserve_draft_usage('00000000-0000-0000-0000-000000000000')
  $$,
  $$
    VALUES ('DENIED'::text, 'DRAFT_JOB_NOT_FOUND'::text)
  $$,
  'reserve_draft_usage returns DENIED for non-existent job'
);

-- Test: archive_draft_failed_job raises exception for non-existent job.
-- Called with three arguments on purpose: p_provider_error_detail defaults to
-- NULL, so pre-20260819000001 call sites must keep resolving to the new
-- function. If that default is ever removed this call stops resolving.
SELECT throws_ok(
  $$
    SELECT * FROM public.archive_draft_failed_job(
      999999,
      '00000000-0000-0000-0000-000000000000',
      'DRAFT_EXHAUSTED_RETRIES'
    )
  $$,
  NULL,
  'archive_draft_failed_job raises exception for non-existent job'
);

-- Test: skip_draft_job raises exception for non-existent job
SELECT throws_ok(
  $$
    SELECT public.skip_draft_job(
      '00000000-0000-0000-0000-000000000000',
      999999,
      'FEATURE_DISABLED'
    )
  $$,
  NULL,
  'skip_draft_job raises exception for non-existent job'
);

-- Test: private schema exists (wrappers delegate to it)
SELECT has_schema('private', 'private schema exists');

-- =============================================================================
-- Cleanup
-- =============================================================================

SELECT * FROM finish();
ROLLBACK;
