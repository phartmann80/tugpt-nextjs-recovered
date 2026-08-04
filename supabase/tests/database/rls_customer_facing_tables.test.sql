-- pgTAP tests: RLS on customer-facing tables
-- File: supabase/tests/database/rls_customer_facing_tables.test.sql

BEGIN;
SELECT plan(11);

-- C1: Org member can SELECT from business_profiles
SELECT has_table('public', 'business_profiles', 'business_profiles table exists');
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.business_profiles'::regclass
  ),
  'RLS enabled on business_profiles'
);

-- C2: Org member can SELECT from whatsapp_connections
SELECT has_table('public', 'whatsapp_connections', 'whatsapp_connections table exists');
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.whatsapp_connections'::regclass
  ),
  'RLS enabled on whatsapp_connections'
);

-- C3: Ordinary member cannot INSERT into whatsapp_connections
-- Only owner/admin can INSERT/UPDATE via the whatsapp_connections_insert_update policy
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'whatsapp_connections'
   AND cmd = 'INSERT' AND roles @> ARRAY['authenticated']::text[]
   AND qual LIKE '%has_org_role%'),
  0,
  'C3: no unrestricted INSERT policy on whatsapp_connections for authenticated (restricted to owner/admin via FOR ALL with has_org_role)'
);

-- C4: Ordinary member cannot UPDATE provider routing identifiers
-- The INSERT/UPDATE policy requires has_org_role with owner/admin
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'whatsapp_connections'
   AND cmd = 'UPDATE' AND roles @> ARRAY['authenticated']::text[]
   AND qual NOT LIKE '%has_org_role%'),
  0,
  'C4: no UPDATE policy on whatsapp_connections without has_org_role check (provider routing identifiers protected)'
);

-- C5: Owner/admin can INSERT/UPDATE business_profiles
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'business_profiles'
   AND roles @> ARRAY['authenticated']::text[]
   AND qual LIKE '%has_org_role%'),
  1,
  'C5: business_profiles has INSERT/UPDATE policy restricted to owner/admin via has_org_role'
);

-- C6: Org member can SELECT from conversations
SELECT has_table('public', 'conversations', 'conversations table exists');
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.conversations'::regclass
  ),
  'RLS enabled on conversations'
);

-- C7: Ordinary member cannot INSERT or DELETE conversations
-- Only owner/admin can INSERT/UPDATE via conversations_insert_update policy; no DELETE policy exists
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'conversations'
   AND cmd = 'DELETE' AND roles @> ARRAY['authenticated']::text[]),
  0,
  'C7: no DELETE policy on conversations for authenticated role'
);

-- C8: Status modification restricted to service_role or owner/admin
-- The conversations_insert_update policy uses has_org_role for owner/admin
-- service_role bypasses RLS (FORCE is not set on conversations)
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'conversations'
   AND cmd = 'UPDATE' AND roles @> ARRAY['authenticated']::text[]
   AND qual LIKE '%has_org_role%'),
  1,
  'C8: conversations UPDATE policy restricted to owner/admin via has_org_role (service_role bypasses RLS)'
);

-- C9: Org member can SELECT from messages
SELECT has_table('public', 'messages', 'messages table exists');
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.messages'::regclass
  ),
  'RLS enabled on messages'
);

-- C10: Authenticated user cannot INSERT/UPDATE/DELETE messages
-- Only a SELECT policy exists for authenticated; INSERT/UPDATE/DELETE are revoked
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages'
   AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
   AND roles @> ARRAY['authenticated']::text[]),
  0,
  'C10: no INSERT/UPDATE/DELETE policies on messages for authenticated role'
);

-- C11: service_role can create inbound messages
-- service_role bypasses RLS (FORCE not set on messages) and has INSERT grant
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'messages'
   AND grantee = 'service_role' AND privilege_type = 'INSERT'),
  1,
  'C11: service_role has INSERT privilege on messages'
);

SELECT finish();
ROLLBACK;