-- Phase 3B Stage 4A: pgTAP tests for public draft RPC wrappers
-- Tests permission and behavior of the public service-role-only wrappers
-- around private draft generation RPCs.

BEGIN;

-- Plan: 16 tests
SELECT plan(16);

-- =============================================================================
-- Permission tests: wrappers must be service_role only
-- =============================================================================

-- reserve_draft_usage wrapper
SELECT has_function(
  'public', 'reserve_draft_usage',
  ARRAY['uuid'],
  'public.reserve_draft_usage wrapper exists'
);

SELECT NOT has_function_privilege(
  'anon', 'public.reserve_draft_usage(uuid)', 'EXECUTE'
) AS ok_2,
'anon cannot execute public.reserve_draft_usage' AS test_name;

SELECT NOT has_function_privilege(
  'authenticated', 'public.reserve_draft_usage(uuid)', 'EXECUTE'
) AS ok_3,
'authenticated cannot execute public.reserve_draft_usage' AS test_name;

SELECT has_function_privilege(
  'service_role', 'public.reserve_draft_usage(uuid)', 'EXECUTE'
) AS ok_4,
'service_role can execute public.reserve_draft_usage' AS test_name;

-- store_draft wrapper
SELECT has_function(
  'public', 'store_draft',
  ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text'],
  'public.store_draft wrapper exists'
);

SELECT NOT has_function_privilege(
  'anon', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
) AS ok_6,
'anon cannot execute public.store_draft' AS test_name;

SELECT NOT has_function_privilege(
  'authenticated', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
) AS ok_7,
'authenticated cannot execute public.store_draft' AS test_name;

SELECT has_function_privilege(
  'service_role', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE'
) AS ok_8,
'service_role can execute public.store_draft' AS test_name;

-- archive_draft_failed_job wrapper
SELECT has_function(
  'public', 'archive_draft_failed_job',
  ARRAY['bigint', 'uuid', 'text'],
  'public.archive_draft_failed_job wrapper exists'
);

SELECT NOT has_function_privilege(
  'anon', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE'
) AS ok_10,
'anon cannot execute public.archive_draft_failed_job' AS test_name;

SELECT NOT has_function_privilege(
  'authenticated', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE'
) AS ok_11,
'authenticated cannot execute public.archive_draft_failed_job' AS test_name;

SELECT has_function_privilege(
  'service_role', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE'
) AS ok_12,
'service_role can execute public.archive_draft_failed_job' AS test_name;

-- skip_draft_job wrapper
SELECT has_function(
  'public', 'skip_draft_job',
  ARRAY['uuid', 'bigint', 'text'],
  'public.skip_draft_job wrapper exists'
);

SELECT NOT has_function_privilege(
  'anon', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'
) AS ok_14,
'anon cannot execute public.skip_draft_job' AS test_name;

SELECT NOT has_function_privilege(
  'authenticated', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'
) AS ok_15,
'authenticated cannot execute public.skip_draft_job' AS test_name;

SELECT has_function_privilege(
  'service_role', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE'
) AS ok_16,
'service_role can execute public.skip_draft_job' AS test_name;

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

-- Test: archive_draft_failed_job raises exception for non-existent job
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

ROLLBACK;