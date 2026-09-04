-- ===========================================================================
-- Take TRUNCATE, TRIGGER and REFERENCES away from anon and authenticated.
--
-- Migration: 20260904000001_revoke_destructive_table_grants.sql
--
-- ---------------------------------------------------------------------------
-- 1. THE FACT THAT MAKES THIS WORTH DOING
-- ---------------------------------------------------------------------------
--
-- RLS DOES NOT APPLY TO TRUNCATE.
--
-- That is not an inference. Measured on this schema's own settings — a table
-- with RLS enabled AND forced, no policy for anon, anon holding only these
-- three privileges:
--
--     anon SELECT   -> ERROR: permission denied for table rls_probe
--     anon TRUNCATE -> TRUNCATE TABLE
--     rows remaining: 0
--
-- A role that cannot read one row can still empty the table. Row-level
-- policies are not a backstop for a table-level grant, and this schema leans
-- on RLS for essentially all of its access control.
--
-- ---------------------------------------------------------------------------
-- 2. HOW THE GRANTS GOT THERE
-- ---------------------------------------------------------------------------
--
-- Nobody granted them. Supabase initialises a project with
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
--
-- so every table a migration creates arrives with ALL already granted. A
-- migration that GRANTs the subset it wants changes nothing; only a REVOKE
-- takes anything away. Fourteen tables in this schema were carrying TRUNCATE,
-- TRIGGER and REFERENCES for anon and/or authenticated as a result.
--
-- Two of them show the narrower version of the same mistake — DML revoked,
-- the rest left behind:
--
--     messages               authenticated: REFERENCES, SELECT, TRIGGER, TRUNCATE
--     feature_flags          anon: everything except SELECT
--     ai_draft_review_events both: INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE
--
-- `contacts` and `organization_invitations` are already correct — they are the
-- two dcfe72c fixed. It fixed two and left fourteen, which is the same narrow
-- fix one level up.
--
-- ---------------------------------------------------------------------------
-- 3. WHAT IS AND IS NOT REVOKED
-- ---------------------------------------------------------------------------
--
-- Exactly three privileges, from exactly two roles. NO DML IS TOUCHED: every
-- SELECT, INSERT, UPDATE and DELETE that anon or authenticated holds today,
-- it holds after this migration. Nothing the dashboard does through PostgREST
-- changes, because PostgREST issues DML and nothing else.
--
-- What the three actually enable, for a role whose row access is entirely
-- RLS-gated:
--
--     TRUNCATE    one statement empties the table, RLS not consulted.
--     TRIGGER     attach a function that fires on every write to the table.
--                 On `messages` that is every inbound customer message.
--     REFERENCES  create a foreign key against the table, which leaks whether
--                 a given value exists.
--
-- None of the three is reachable through PostgREST, so there is no known path
-- from a browser key to using them today. This is defence in depth on a
-- schema whose entire access model is row policies — not a response to an
-- incident.
--
-- ---------------------------------------------------------------------------
-- 4. WHY A LOOP AND NOT A LIST
-- ---------------------------------------------------------------------------
--
-- A hand-written list of fourteen table names is correct on the day it is
-- written and wrong the first time somebody adds a table. The loop covers
-- what exists; `table_privilege_hygiene.test.sql` covers what comes next, by
-- failing on any public table that grants these three to either role.
--
-- ---------------------------------------------------------------------------
-- 5. WHAT THIS DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
--
-- It does not add `ALTER DEFAULT PRIVILEGES ... REVOKE` for future tables.
--
-- That form is scoped to the role that creates the object, so it would cover
-- tables created by `postgres` and silently miss any created by another role.
-- A mechanism that covers most cases while reading as though it covers all of
-- them is the exact shape of the defect this migration is cleaning up. The
-- guard test covers every table unconditionally, and a new table tripping it
-- is a two-line REVOKE plus a deliberate decision — which is the outcome
-- worth having.
--
-- It also leaves service_role alone. service_role is the backend's identity
-- and legitimately administers these tables; the credential tables narrowed it
-- deliberately in 20260903000003 and said so in a test.
-- ===========================================================================

DO $$
DECLARE
  v_table TEXT;
  v_count INTEGER := 0;
BEGIN
  FOR v_table IN
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.%I FROM anon, authenticated',
      v_table
    );
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'revoked TRUNCATE/TRIGGER/REFERENCES from anon and authenticated on % table(s)', v_count;
END
$$;

COMMENT ON SCHEMA public IS
  'Application schema. anon and authenticated must never hold TRUNCATE, '
  'TRIGGER or REFERENCES on any table here: RLS does not apply to TRUNCATE, '
  'and TRIGGER would let a browser role attach a function to every write. '
  'Enforced by supabase/tests/database/table_privilege_hygiene.test.sql.';
