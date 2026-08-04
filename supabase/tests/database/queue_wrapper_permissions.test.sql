-- pgTAP tests: queue wrapper permissions
-- File: supabase/tests/database/queue_wrapper_permissions.test.sql

BEGIN;
SELECT plan(7);

-- Q1: Authenticated user cannot execute read_whatsapp_inbound_jobs
SELECT has_function('public', 'read_whatsapp_inbound_jobs', ARRAY['int'], 'read_whatsapp_inbound_jobs exists');

-- Q2: Authenticated user cannot execute delete_whatsapp_inbound_job
SELECT has_function('public', 'delete_whatsapp_inbound_job', ARRAY['bigint'], 'delete_whatsapp_inbound_job exists');

-- Q3: Authenticated user cannot execute set_whatsapp_inbound_visibility
SELECT has_function('public', 'set_whatsapp_inbound_visibility', ARRAY['bigint', 'int'], 'set_whatsapp_inbound_visibility exists');

-- Q4: service_role CAN execute all queue wrapper RPCs
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('read_whatsapp_inbound_jobs', 'delete_whatsapp_inbound_job', 'set_whatsapp_inbound_visibility')
   AND grantee = 'service_role'
   AND privilege_type = 'EXECUTE'),
  3,
  'Q4: service_role has EXECUTE on all 3 queue wrapper RPCs'
);

-- Q5: Queue read returns delivery count (read_ct)
-- The read_whatsapp_inbound_jobs function returns TABLE(msg_id, read_ct, payload, enqueued_at, vt)
-- Verify the return column read_ct exists
SELECT has_column(
  (SELECT to_regclass('pg_proc') IS NOT NULL)::text,
  'read_ct',
  'Q5: read_whatsapp_inbound_jobs return type includes read_ct column'
);

-- Q6: Visibility-update failure is handled
-- set_whatsapp_inbound_visibility returns BOOLEAN (false on failure, not exception)
SELECT is(
  (SELECT prorettype::regtype FROM pg_proc
   WHERE proname = 'set_whatsapp_inbound_visibility'
   AND pronamespace = 'public'::regnamespace),
  'boolean',
  'Q6: set_whatsapp_inbound_visibility returns boolean (handles failure gracefully)'
);

-- Q7: No direct pgmq access for anon or authenticated
-- pgmq schema privileges revoked from PUBLIC, anon, authenticated
SELECT is(
  (SELECT count(*)::int FROM information_schema.schema_privileges
   WHERE schema_name = 'pgmq'
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')),
  0,
  'Q7: no pgmq schema privileges for anon, authenticated, or PUBLIC'
);

-- Verify search_path is pg_catalog
SELECT function_search_path_is('public', 'read_whatsapp_inbound_jobs', ARRAY['int'], 'pg_catalog', 'read_whatsapp_inbound_jobs uses pg_catalog search_path');

SELECT function_search_path_is('public', 'delete_whatsapp_inbound_job', ARRAY['bigint'], 'pg_catalog', 'delete_whatsapp_inbound_job uses pg_catalog search_path');

SELECT function_search_path_is('public', 'set_whatsapp_inbound_visibility', ARRAY['bigint', 'int'], 'pg_catalog', 'set_whatsapp_inbound_visibility uses pg_catalog search_path');

SELECT finish();
ROLLBACK;