-- pgTAP tests: RLS on operational tables
-- File: supabase/tests/database/rls_operational_tables.test.sql

BEGIN;
SELECT plan(8);

-- R1: webhook_events table exists
SELECT has_table('public', 'webhook_events', 'webhook_events table exists');

-- R2: inbound_message_staging table exists
SELECT has_table('public', 'inbound_message_staging', 'inbound_message_staging table exists');

-- R3: failed_jobs table exists
SELECT has_table('public', 'failed_jobs', 'failed_jobs table exists');

-- R4: Authenticated user cannot SELECT from webhook_events
-- RLS is ENABLED + FORCE with no policies for authenticated users.
-- With FORCE, even the table owner is subject to RLS.
-- No SELECT policy exists for authenticated, so all rows are invisible.
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.webhook_events'::regclass
  ),
  'RLS enabled on webhook_events'
);
SELECT ok(
  (
    SELECT c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.webhook_events'::regclass
  ),
  'RLS forced on webhook_events'
);

-- R5: Authenticated owner cannot SELECT from failed_jobs
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.failed_jobs'::regclass
  ),
  'RLS enabled on failed_jobs'
);
SELECT ok(
  (
    SELECT c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.failed_jobs'::regclass
  ),
  'RLS forced on failed_jobs'
);

-- R6: Authenticated admin cannot INSERT into failed_jobs
-- Verify no INSERT policy exists on failed_jobs for authenticated role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'failed_jobs'
   AND cmd = 'INSERT' AND roles @> ARRAY['authenticated']::text[]),
  0,
  'R6: no INSERT policy on failed_jobs for authenticated role'
);

-- R7: service_role CAN SELECT/INSERT/UPDATE/DELETE on all operational tables
-- Verify grants exist for service_role
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
   AND table_name IN ('webhook_events', 'inbound_message_staging', 'failed_jobs')
   AND grantee = 'service_role'
   AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  12,
  'R7: service_role has SELECT/INSERT/UPDATE/DELETE on all 3 operational tables (12 grants)'
);

-- R8: No authenticated-user policies exist on operational tables
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public'
   AND tablename IN ('webhook_events', 'inbound_message_staging', 'failed_jobs')
   AND roles @> ARRAY['authenticated']::text[]),
  0,
  'R8: no authenticated-user policies on operational tables'
);

SELECT finish();
ROLLBACK;