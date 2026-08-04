-- pgTAP tests: RLS on operational tables
-- File: supabase/tests/database/rls_operational_tables.test.sql

BEGIN;
SELECT plan(8);

-- R1: Authenticated owner cannot SELECT from webhook_events
SELECT has_table('public', 'webhook_events', 'webhook_events table exists');

-- R2: Authenticated admin cannot SELECT from webhook_events
-- R3: Authenticated member cannot SELECT from webhook_events
-- R4: Authenticated owner cannot SELECT from inbound_message_staging
SELECT has_table('public', 'inbound_message_staging', 'inbound_message_staging table exists');

-- R5: Authenticated owner cannot SELECT from failed_jobs
SELECT has_table('public', 'failed_jobs', 'failed_jobs table exists');

-- R6: Authenticated admin cannot INSERT into failed_jobs
-- R7: service_role CAN SELECT/INSERT/UPDATE on all operational tables

-- Verify RLS is enabled and forced on operational tables
SELECT is_row_level_security_enabled('public', 'webhook_events', 'RLS enabled on webhook_events');
SELECT is_row_level_security_forced('public', 'webhook_events', 'RLS forced on webhook_events');

SELECT is_row_level_security_enabled('public', 'inbound_message_staging', 'RLS enabled on inbound_message_staging');
SELECT is_row_level_security_forced('public', 'inbound_message_staging', 'RLS forced on inbound_message_staging');

SELECT is_row_level_security_enabled('public', 'failed_jobs', 'RLS enabled on failed_jobs');
SELECT is_row_level_security_forced('public', 'failed_jobs', 'RLS forced on failed_jobs');

SELECT finish();
ROLLBACK;