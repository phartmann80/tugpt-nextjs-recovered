-- pgTAP tests: RLS on customer-facing tables
-- File: supabase/tests/database/rls_customer_facing_tables.test.sql

BEGIN;
SELECT plan(11);

-- C1: business_profiles table exists with RLS enabled
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.business_profiles'::regclass
  ),
  'C1: RLS enabled on business_profiles'
);

-- C2: whatsapp_connections table exists with RLS enabled
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.whatsapp_connections'::regclass
  ),
  'C2: RLS enabled on whatsapp_connections'
);

-- C3: No unrestricted INSERT policy on whatsapp_connections for authenticated
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'whatsapp_connections'
   AND cmd = 'INSERT' AND roles @> ARRAY['authenticated']::name[]
   AND qual LIKE '%has_org_role%'),
  0,
  'C3: no unrestricted INSERT policy on whatsapp_connections for authenticated (restricted to owner/admin via FOR ALL with has_org_role)'
);

-- C4: No UPDATE policy on whatsapp_connections without has_org_role check
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'whatsapp_connections'
   AND cmd = 'UPDATE' AND roles @> ARRAY['authenticated']::name[]
   AND qual NOT LIKE '%has_org_role%'),
  0,
  'C4: no UPDATE policy on whatsapp_connections without has_org_role check (provider routing identifiers protected)'
);

-- C5: business_profiles has INSERT/UPDATE policy restricted to owner/admin via has_org_role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'business_profiles'
   AND roles @> ARRAY['authenticated']::name[]
   AND qual LIKE '%has_org_role%'),
  1,
  'C5: business_profiles has INSERT/UPDATE policy restricted to owner/admin via has_org_role'
);

-- C6: conversations table exists with RLS enabled
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.conversations'::regclass
  ),
  'C6: RLS enabled on conversations'
);

-- C7: No DELETE policy on conversations for authenticated role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'conversations'
   AND cmd = 'DELETE' AND roles @> ARRAY['authenticated']::name[]),
  0,
  'C7: no DELETE policy on conversations for authenticated role'
);

-- C8: Conversations UPDATE policy restricted to owner/admin via has_org_role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'conversations'
   AND cmd = 'UPDATE' AND roles @> ARRAY['authenticated']::name[]
   AND qual LIKE '%has_org_role%'),
  1,
  'C8: conversations UPDATE policy restricted to owner/admin via has_org_role (service_role bypasses RLS)'
);

-- C9: messages table exists with RLS enabled
SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.messages'::regclass
  ),
  'C9: RLS enabled on messages'
);

-- C10: No INSERT/UPDATE/DELETE policies on messages for authenticated role
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'messages'
   AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
   AND roles @> ARRAY['authenticated']::name[]),
  0,
  'C10: no INSERT/UPDATE/DELETE policies on messages for authenticated role'
);

-- C11: service_role has INSERT privilege on messages
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'messages'
   AND grantee = 'service_role' AND privilege_type = 'INSERT'),
  1,
  'C11: service_role has INSERT privilege on messages'
);

SELECT finish();
ROLLBACK;