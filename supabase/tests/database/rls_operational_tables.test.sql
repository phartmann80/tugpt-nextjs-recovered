-- pgTAP tests: RLS on operational tables
-- File: supabase/tests/database/rls_operational_tables.test.sql

BEGIN;
SELECT plan(8);

-- R1: webhook_events table exists
SELECT has_table('public', 'webhook_events', 'R1: webhook_events table exists');

-- R2: inbound_message_staging table exists
SELECT has_table('public', 'inbound_message_staging', 'R2: inbound_message_staging table exists');

-- R3: failed_jobs table exists
SELECT has_table('public', 'failed_jobs', 'R3: failed_jobs table exists');

-- R4: RLS enabled + forced on webhook_events
SELECT ok(
  (
    SELECT c.relrowsecurity AND c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.webhook_events'::regclass
  ),
  'R4: RLS enabled and forced on webhook_events'
);

-- R5: RLS enabled + forced on failed_jobs
SELECT ok(
  (
    SELECT c.relrowsecurity AND c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.failed_jobs'::regclass
  ),
  'R5: RLS enabled and forced on failed_jobs'
);

-- R6: No INSERT policy on failed_jobs for authenticated role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'failed_jobs'
   AND cmd = 'INSERT' AND roles @> ARRAY['authenticated']::name[]),
  0,
  'R6: no INSERT policy on failed_jobs for authenticated role'
);

-- R7: service_role has SELECT/INSERT/UPDATE/DELETE on all 3 operational tables (12 grants)
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
   AND roles @> ARRAY['authenticated']::name[]),
  0,
  'R8: no authenticated-user policies on operational tables'
);

SELECT finish();
ROLLBACK;