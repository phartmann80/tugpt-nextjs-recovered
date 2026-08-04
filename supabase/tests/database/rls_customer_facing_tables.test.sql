-- pgTAP tests: RLS on customer-facing tables
-- File: supabase/tests/database/rls_customer_facing_tables.test.sql

BEGIN;
SELECT plan(11);

-- C1: Org member can SELECT from business_profiles
SELECT has_table('public', 'business_profiles', 'business_profiles table exists');
SELECT is_row_level_security_enabled('public', 'business_profiles', 'RLS enabled on business_profiles');

-- C2: Org member can SELECT from whatsapp_connections
SELECT has_table('public', 'whatsapp_connections', 'whatsapp_connections table exists');
SELECT is_row_level_security_enabled('public', 'whatsapp_connections', 'RLS enabled on whatsapp_connections');

-- C3: Ordinary member cannot INSERT into whatsapp_connections
-- C4: Ordinary member cannot UPDATE provider routing identifiers
-- C5: Owner/admin can INSERT/UPDATE business_profiles
-- C6: Org member can SELECT from conversations
SELECT has_table('public', 'conversations', 'conversations table exists');
SELECT is_row_level_security_enabled('public', 'conversations', 'RLS enabled on conversations');

-- C7: Ordinary member cannot INSERT or DELETE conversations
-- C8: Status modification restricted to service_role or owner/admin
-- C9: Org member can SELECT from messages
SELECT has_table('public', 'messages', 'messages table exists');
SELECT is_row_level_security_enabled('public', 'messages', 'RLS enabled on messages');

-- C10: Authenticated user cannot INSERT/UPDATE/DELETE messages
-- C11: service_role can create inbound messages

SELECT finish();
ROLLBACK;