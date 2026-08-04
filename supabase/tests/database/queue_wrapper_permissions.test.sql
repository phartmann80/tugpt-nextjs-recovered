-- pgTAP tests: queue wrapper permissions
-- File: supabase/tests/database/queue_wrapper_permissions.test.sql

BEGIN;
SELECT plan(7);

-- Q1: read_whatsapp_inbound_jobs function exists
SELECT has_function('public', 'read_whatsapp_inbound_jobs', ARRAY['int', 'int'], 'read_whatsapp_inbound_jobs exists');

-- Q2: delete_whatsapp_inbound_job function exists
SELECT has_function('public', 'delete_whatsapp_inbound_job', ARRAY['bigint'], 'delete_whatsapp_inbound_job exists');

-- Q3: set_whatsapp_inbound_visibility function exists
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

-- Q5: read_whatsapp_inbound_jobs return type includes read_ct column
SELECT ok(
  (SELECT pg_get_function_result(p.oid) LIKE '%read_ct%'
   FROM pg_catalog.pg_proc AS p
   WHERE p.oid = 'public.read_whatsapp_inbound_jobs(integer,integer)'::regprocedure),
  'Q5: read_whatsapp_inbound_jobs return type includes read_ct column'
);

-- Q6: set_whatsapp_inbound_visibility returns boolean (handles failure gracefully)
SELECT is(
  (SELECT prorettype::regtype FROM pg_proc
   WHERE proname = 'set_whatsapp_inbound_visibility'
   AND pronamespace = 'public'::regnamespace),
  'boolean',
  'Q6: set_whatsapp_inbound_visibility returns boolean (handles failure gracefully)'
);

-- Q7: No direct pgmq access for anon, authenticated, or PUBLIC
-- PUBLIC is a pseudo-role, not a valid user argument for has_schema_privilege().
-- Use aclexplode to check the PUBLIC (grantee=0) ACL entry directly.
SELECT ok(
  NOT has_schema_privilege('anon', 'pgmq', 'USAGE')
  AND NOT has_schema_privilege('authenticated', 'pgmq', 'USAGE')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS n
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        n.nspacl,
        pg_catalog.acldefault('n', n.nspowner)
      )
    ) AS acl
    WHERE n.nspname = 'pgmq'
      AND acl.grantee = 0::oid
      AND acl.privilege_type = 'USAGE'
  ),
  'Q7: no pgmq schema USAGE for anon, authenticated, or PUBLIC'
);

SELECT finish();
ROLLBACK;