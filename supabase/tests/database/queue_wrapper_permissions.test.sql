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
-- Introspect the actual function declaration via pg_catalog.pg_get_function_result
-- The function returns TABLE(msg_id, read_ct, payload, enqueued_at, vt)
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
-- information_schema.schema_privileges does not exist; use has_schema_privilege() instead.
SELECT is(
  (SELECT count(*)::int FROM (
    SELECT 1 WHERE has_schema_privilege('anon', 'pgmq', 'USAGE')
    UNION ALL
    SELECT 1 WHERE has_schema_privilege('authenticated', 'pgmq', 'USAGE')
    UNION ALL
    SELECT 1 WHERE has_schema_privilege('PUBLIC', 'pgmq', 'USAGE')
  ) AS privs),
  0,
  'Q7: no pgmq schema USAGE privileges for anon, authenticated, or PUBLIC'
);

-- Verify search_path is pg_catalog for all 3 queue wrapper RPCs via pg_proc.proconfig
SELECT ok(
  COALESCE(
    (SELECT 'search_path=pg_catalog' = ANY(p.proconfig)
     FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.read_whatsapp_inbound_jobs(integer,integer)'::regprocedure),
    false
  ),
  'read_whatsapp_inbound_jobs has fixed pg_catalog search_path'
);

SELECT ok(
  COALESCE(
    (SELECT 'search_path=pg_catalog' = ANY(p.proconfig)
     FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.delete_whatsapp_inbound_job(bigint)'::regprocedure),
    false
  ),
  'delete_whatsapp_inbound_job has fixed pg_catalog search_path'
);

SELECT ok(
  COALESCE(
    (SELECT 'search_path=pg_catalog' = ANY(p.proconfig)
     FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.set_whatsapp_inbound_visibility(bigint,integer)'::regprocedure),
    false
  ),
  'set_whatsapp_inbound_visibility has fixed pg_catalog search_path'
);

SELECT finish();
ROLLBACK;