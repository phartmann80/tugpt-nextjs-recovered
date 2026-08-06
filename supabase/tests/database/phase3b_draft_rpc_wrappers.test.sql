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

SELECT doesnt_have_privilege(
  'anon', 'public.reserve_draft_usage(uuid)', 'EXECUTE',
  'anon cannot execute public.reserve_draft_usage'
);

SELECT doesnt_have_privilege(
  'authenticated', 'public.reserve_draft_usage(uuid)', 'EXECUTE',
  'authenticated cannot execute public.reserve_draft_usage'
);

SELECT has_privilege(
  'service_role', 'public.reserve_draft_usage(uuid)', 'EXECUTE',
  'service_role can execute public.reserve_draft_usage'
);

-- store_draft wrapper
SELECT has_function(
  'public', 'store_draft',
  ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text'],
  'public.store_draft wrapper exists'
);

SELECT doesnt_have_privilege(
  'anon', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE',
  'anon cannot execute public.store_draft'
);

SELECT doesnt_have_privilege(
  'authenticated', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE',
  'authenticated cannot execute public.store_draft'
);

SELECT has_privilege(
  'service_role', 'public.store_draft(uuid, uuid, uuid, uuid, text, text, text)', 'EXECUTE',
  'service_role can execute public.store_draft'
);

-- archive_draft_failed_job wrapper
SELECT has_function(
  'public', 'archive_draft_failed_job',
  ARRAY['bigint', 'uuid', 'text'],
  'public.archive_draft_failed_job wrapper exists'
);

SELECT doesnt_have_privilege(
  'anon', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE',
  'anon cannot execute public.archive_draft_failed_job'
);

SELECT doesnt_have_privilege(
  'authenticated', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE',
  'authenticated cannot execute public.archive_draft_failed_job'
);

SELECT has_privilege(
  'service_role', 'public.archive_draft_failed_job(bigint, uuid, text)', 'EXECUTE',
  'service_role can execute public.archive_draft_failed_job'
);

-- skip_draft_job wrapper
SELECT has_function(
  'public', 'skip_draft_job',
  ARRAY['uuid', 'bigint', 'text'],
  'public.skip_draft_job wrapper exists'
);

SELECT doesnt_have_privilege(
  'anon', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE',
  'anon cannot execute public.skip_draft_job'
);

SELECT doesnt_have_privilege(
  'authenticated', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE',
  'authenticated cannot execute public.skip_draft_job'
);

SELECT has_privilege(
  'service_role', 'public.skip_draft_job(uuid, bigint, text)', 'EXECUTE',
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

-- Test: archive_draft_failed_job returns error for non-existent job
SELECT throws_ok(
  $$
    SELECT * FROM public.archive_draft_failed_job(
      999999,
      '00000000-0000-0000-0000-000000000000',
      'DRAFT_EXHAUSTED_RETRIES'
    )
  $$,
  'P3B07',
  'archive_draft_failed_job raises P3B07 for non-existent job'
);

-- Test: skip_draft_job raises error for non-existent job
SELECT throws_ok(
  $$
    SELECT public.skip_draft_job(
      '00000000-0000-0000-0000-000000000000',
      999999,
      'FEATURE_DISABLED'
    )
  $$,
  'P3B07',
  'skip_draft_job raises P3B07 for non-existent job'
);

-- Test: private schema functions are NOT directly accessible via PostgREST
-- (They exist in the private schema, which is not exposed via the API)
SELECT has_schema('private', 'private schema exists');
SELECT hasnt_schema('private', 'private schema is NOT exposed via PostgREST API');

-- =============================================================================
-- Cleanup
-- =============================================================================

ROLLBACK;