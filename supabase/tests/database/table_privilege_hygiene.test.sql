-- table_privilege_hygiene.test.sql
--
-- One rule, applied to every table in `public`, forever:
--
--     anon and authenticated hold no TRUNCATE, no TRIGGER, no REFERENCES.
--
-- WHY THIS IS A GUARD AND NOT A LIST
--
-- The migration that made this true (20260904000001) loops over the tables
-- that existed when it ran. The next table added to this schema arrives with
-- Supabase's default privileges — ALL, for these roles — and the migration
-- cannot reach back in time to fix it. So the enforcement has to be a query
-- over the catalogue rather than a set of table names, and it has to fail
-- rather than warn.
--
-- WHY IT MATTERS MORE THAN IT LOOKS
--
-- RLS DOES NOT APPLY TO TRUNCATE. Measured, not assumed: a table with RLS
-- enabled and forced, no policy for anon, anon granted only these three
-- privileges — SELECT is refused outright, TRUNCATE succeeds, table empty.
-- Every other access control in this schema is a row policy. This is the one
-- category of privilege those policies do not cover, which is exactly why it
-- deserves a test that cannot be satisfied by adding a policy.
--
-- WHAT THIS DOES NOT ASSERT
--
-- Anything about DML. The migration touches none, deliberately: PostgREST
-- issues SELECT/INSERT/UPDATE/DELETE and nothing else, so the dashboard is
-- unaffected. H4 and H5 below are the positive controls that prove the DML is
-- still there rather than having been swept away with the rest.

BEGIN;
SELECT plan(9);

-- ===========================================================================
-- H: the rule itself
-- ===========================================================================

-- The whole point, stated once. Named tables in the failure output, because
-- "some table somewhere" is a test nobody can act on at 2am.
SELECT is(
  (SELECT COALESCE(string_agg(DISTINCT table_name || ':' || grantee || ':' || privilege_type, ', '
                              ORDER BY table_name || ':' || grantee || ':' || privilege_type), '')
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  '',
  'H1: no public table grants TRUNCATE, TRIGGER or REFERENCES to anon or authenticated'
);

-- Stated again against the two roles separately, so a failure says which one.
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'anon'
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  0,
  'H2: anon — the key that ships to browsers — holds none of the three'
);

SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'authenticated'
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  0,
  'H3: authenticated holds none of the three'
);

-- ===========================================================================
-- H4-H5: positive controls
-- ===========================================================================
--
-- H1-H3 are all "count is zero". They would pass just as happily against a
-- schema where every grant had been revoked and the dashboard was dead. These
-- two assert the DML the migration promised not to touch is still present.

SELECT ok(
  (SELECT count(*) FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) > 0,
  'H4: DML for anon/authenticated still exists somewhere — H1-H3 are not '
  'passing because every grant was swept away'
);

-- The specific one a human would notice first: the dashboard reads contacts.
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'contacts'
     AND grantee = 'authenticated' AND privilege_type = 'SELECT'),
  1,
  'H5: authenticated still has SELECT on contacts'
);

-- ===========================================================================
-- H6: service_role is not in scope
-- ===========================================================================
--
-- service_role is the backend's identity and administers these tables. The
-- credential tables narrowed it deliberately in 20260903000003 and asserted
-- that separately; everywhere else it keeps the Supabase default. Pinned here
-- so that a future broad revoke cannot quietly take the backend's own
-- privileges with it.

SELECT ok(
  (SELECT count(*) FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'service_role'
     AND privilege_type = 'TRUNCATE') > 0,
  'H6: service_role is untouched — this migration is about browser roles'
);

-- ===========================================================================
-- H7-H8: the starting condition, and that the revoke actually clears it
-- ===========================================================================
--
-- H1-H3 pass on a clean schema. They would also pass if the query were subtly
-- wrong — wrong schema, misspelled privilege, wrong catalogue view. The only
-- way to know the query can see a violation is to produce one.
--
-- Producing one takes no effort at all, which is the finding: a brand-new
-- table arrives holding all three for BOTH browser roles, because Supabase's
-- default privileges grant ALL on every new table in this schema. H7 is
-- therefore not a contrived fixture — it is what every future table looks
-- like on the day it is created, and it is why the guard exists rather than a
-- one-time revoke being enough.
--
-- Inside the transaction, so the probe is gone at ROLLBACK.

CREATE TABLE public.privilege_hygiene_probe (id INTEGER);

SELECT is(
  (SELECT string_agg(DISTINCT grantee || ':' || privilege_type, ', '
                     ORDER BY grantee || ':' || privilege_type)
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'privilege_hygiene_probe'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  'anon:REFERENCES, anon:TRIGGER, anon:TRUNCATE, '
  'authenticated:REFERENCES, authenticated:TRIGGER, authenticated:TRUNCATE',
  'H7: a brand-new table arrives holding all three for both browser roles — '
  'the guard query can see a violation, and this is the default state'
);

-- What the probe holds before the revoke, so H9 can assert the difference
-- rather than an absolute set that varies with how the database was set up.
CREATE TEMP TABLE _probe_before AS
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'privilege_hygiene_probe'
  AND grantee = 'authenticated';

-- The migration's statement, verbatim, applied to the probe.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.privilege_hygiene_probe
  FROM anon, authenticated;

SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'privilege_hygiene_probe'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  0,
  'H8: ...and the migration''s own REVOKE clears exactly those three'
);

-- The other half of H8: the revoke took the three and NOTHING ELSE. A REVOKE
-- that also removed SELECT would satisfy H8 and break the dashboard.
--
-- Stated as a difference rather than as an expected set, and that distinction
-- is not stylistic. Written as an absolute — 'DELETE,INSERT,SELECT,UPDATE' —
-- this assertion passed locally and failed in CI, because the exact default
-- privileges a new table receives are a property of how the database was
-- initialised, and the local harness only approximates that. What this test
-- actually claims is about the REVOKE, not about the defaults: whatever the
-- probe arrived holding, exactly three privileges left. That claim is true on
-- any database, which is what makes it worth asserting.
SELECT is(
  (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
   FROM (
     SELECT privilege_type FROM _probe_before
     EXCEPT
     SELECT privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'privilege_hygiene_probe'
       AND grantee = 'authenticated'
   ) removed),
  'REFERENCES,TRIGGER,TRUNCATE',
  'H9: the REVOKE removed exactly those three from authenticated and nothing else'
);

SELECT * FROM finish();
ROLLBACK;
