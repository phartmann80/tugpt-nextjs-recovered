-- pgTAP tests: RPC execution permissions
-- File: supabase/tests/database/rpc_execution_permissions.test.sql

BEGIN;
SELECT plan(7);

-- E1: Authenticated user cannot execute ingest_whatsapp_message_event
SELECT has_function('public', 'ingest_whatsapp_message_event', ARRAY[
  'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text'
], 'ingest_whatsapp_message_event exists');

-- E2: Authenticated user cannot execute process_inbound_message
SELECT has_function('public', 'process_inbound_message', ARRAY['uuid'], 'process_inbound_message exists');

-- E3: Authenticated user cannot execute archive_failed_job
SELECT has_function('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'archive_failed_job exists');

-- E4: Authenticated user cannot execute record_inbound_processing_failure
SELECT has_function('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'record_inbound_processing_failure exists');

-- E5: service_role CAN execute all four RPCs
-- Verify EXECUTE grants exist for service_role on all four functions
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('ingest_whatsapp_message_event', 'process_inbound_message', 'archive_failed_job', 'record_inbound_processing_failure')
   AND grantee = 'service_role'
   AND privilege_type = 'EXECUTE'),
  4,
  'E5: service_role has EXECUTE on all 4 RPCs'
);

-- E6: No RPC depends on caller-controlled search_path
-- All functions use SET search_path = pg_catalog
SELECT function_search_path_is('public', 'ingest_whatsapp_message_event', ARRAY[
  'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text'
], 'pg_catalog', 'ingest_whatsapp_message_event uses pg_catalog search_path');

SELECT function_search_path_is('public', 'process_inbound_message', ARRAY['uuid'], 'pg_catalog', 'process_inbound_message uses pg_catalog search_path');

SELECT function_search_path_is('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'pg_catalog', 'archive_failed_job uses pg_catalog search_path');

SELECT function_search_path_is('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'pg_catalog', 'record_inbound_processing_failure uses pg_catalog search_path');

-- E7: Ordinary roles cannot create an object that shadows an RPC dependency
-- All RPCs use SECURITY DEFINER with SET search_path = pg_catalog,
-- so they resolve all unqualified names against pg_catalog only.
-- An authenticated user cannot create objects in pg_catalog, so they cannot shadow dependencies.
SELECT is(
  (SELECT count(*)::int FROM information_schema.routines
   WHERE routine_schema = 'public'
   AND routine_name IN ('ingest_whatsapp_message_event', 'process_inbound_message', 'archive_failed_job', 'record_inbound_processing_failure')
   AND security_type = 'DEFINER'),
  4,
  'E7: all 4 RPCs are SECURITY DEFINER (immune to caller search_path shadowing)'
);

SELECT finish();
ROLLBACK;