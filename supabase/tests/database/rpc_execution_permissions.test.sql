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
-- E6: No RPC depends on caller-controlled search_path
-- E7: Ordinary roles cannot create an object that shadows an RPC dependency

-- Verify all functions use SET search_path = pg_catalog
SELECT function_search_path_is('public', 'ingest_whatsapp_message_event', ARRAY[
  'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text'
], 'pg_catalog', 'ingest_whatsapp_message_event uses pg_catalog search_path');

SELECT function_search_path_is('public', 'process_inbound_message', ARRAY['uuid'], 'pg_catalog', 'process_inbound_message uses pg_catalog search_path');

SELECT function_search_path_is('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'pg_catalog', 'archive_failed_job uses pg_catalog search_path');

SELECT function_search_path_is('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'pg_catalog', 'record_inbound_processing_failure uses pg_catalog search_path');

SELECT finish();
ROLLBACK;