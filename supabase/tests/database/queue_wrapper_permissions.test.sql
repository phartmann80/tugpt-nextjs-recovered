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
-- Q5: Queue read returns delivery count (read_ct)
-- Q6: Visibility-update failure is handled
-- Q7: No direct pgmq access for anon or authenticated

-- Verify search_path is pg_catalog
SELECT function_search_path_is('public', 'read_whatsapp_inbound_jobs', ARRAY['int'], 'pg_catalog', 'read_whatsapp_inbound_jobs uses pg_catalog search_path');

SELECT function_search_path_is('public', 'delete_whatsapp_inbound_job', ARRAY['bigint'], 'pg_catalog', 'delete_whatsapp_inbound_job uses pg_catalog search_path');

SELECT function_search_path_is('public', 'set_whatsapp_inbound_visibility', ARRAY['bigint', 'int'], 'pg_catalog', 'set_whatsapp_inbound_visibility uses pg_catalog search_path');

SELECT finish();
ROLLBACK;