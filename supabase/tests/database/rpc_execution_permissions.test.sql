-- pgTAP tests: RPC execution permissions
-- File: supabase/tests/database/rpc_execution_permissions.test.sql

BEGIN;
SELECT plan(7);

-- E1: ingest_whatsapp_message_event function exists
SELECT has_function('public', 'ingest_whatsapp_message_event', ARRAY[
  'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text'
], 'ingest_whatsapp_message_event exists');

-- E2: process_inbound_message function exists
SELECT has_function('public', 'process_inbound_message', ARRAY['uuid'], 'process_inbound_message exists');

-- E3: archive_failed_job function exists
SELECT has_function('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'archive_failed_job exists');

-- E4: record_inbound_processing_failure function exists
SELECT has_function('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'record_inbound_processing_failure exists');

-- E5: service_role CAN execute all four RPCs
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('ingest_whatsapp_message_event', 'process_inbound_message', 'archive_failed_job', 'record_inbound_processing_failure')
   AND grantee = 'service_role'
   AND privilege_type = 'EXECUTE'),
  4,
  'E5: service_role has EXECUTE on all 4 RPCs'
);

-- E6: All 4 RPCs use SECURITY DEFINER with fixed pg_catalog search_path
SELECT is(
  (SELECT count(*)::int FROM information_schema.routines
   WHERE routine_schema = 'public'
   AND routine_name IN ('ingest_whatsapp_message_event', 'process_inbound_message', 'archive_failed_job', 'record_inbound_processing_failure')
   AND security_type = 'DEFINER'),
  4,
  'E6: all 4 RPCs are SECURITY DEFINER (immune to caller search_path shadowing)'
);

-- E7: All 4 RPCs have fixed search_path = pg_catalog via pg_proc.proconfig
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_proc AS p
   WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('ingest_whatsapp_message_event', 'process_inbound_message', 'archive_failed_job', 'record_inbound_processing_failure')
   AND 'search_path=pg_catalog' = ANY(p.proconfig)),
  4,
  'E7: all 4 RPCs have fixed pg_catalog search_path in proconfig'
);

SELECT finish();
ROLLBACK;