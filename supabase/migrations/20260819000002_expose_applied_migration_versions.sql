-- Migration: 20260819000002_expose_applied_migration_versions.sql
--
-- WHY
-- On 2026-08-19 the milestone-1 end-to-end run completed and reported success
-- against a staging database that was missing migration 20260819000001. The
-- checkout on the VPS had never been linked to a Supabase project, so
-- `supabase db push` failed with "Cannot find project ref", and nothing that
-- ran afterwards treated the gap as fatal. The harness printed a warning about
-- a missing column and carried on.
--
-- The generic fix is for the harness to compare the migration files in the
-- checkout against the versions the database has actually recorded, and refuse
-- to run when the checkout is ahead. The Supabase CLI keeps that record in
-- supabase_migrations.schema_migrations, but that schema is not in PostgREST's
-- exposed-schema list, so a PostgREST client — which is what the workers and
-- the harness are — cannot read it.
--
-- This migration exposes exactly that list, read-only, to service_role only.
--
-- WHAT IS AND IS NOT EXPOSED
-- Only the version timestamp and the migration name. Not `statements`, which
-- holds the migration SQL itself and is of no use to a caller checking whether
-- its schema is current. anon and authenticated cannot execute the function at
-- all, so no tenant can see it; this is deployment metadata for operators, in
-- the same category as the worker's own service-role access.
--
-- The function tolerates the ledger table being absent (a database built by
-- some means other than `supabase db push`) by returning no rows. The caller
-- treats an empty result as "cannot verify", which fails closed.

-- -----------------------------------------------------------------------------
-- private implementation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.applied_migration_versions()
RETURNS TABLE(version TEXT, name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- Dynamic SQL, and a to_regclass guard, so that creating this function does
  -- not require the ledger table to exist at migration time.
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE
    'SELECT version::text, name::text
       FROM supabase_migrations.schema_migrations
      ORDER BY version';
END;
$$;

COMMENT ON FUNCTION private.applied_migration_versions() IS
  'Versions recorded in supabase_migrations.schema_migrations. Deployment metadata for operators and the milestone-1 harness preflight; service_role only. Never exposes migration SQL.';

REVOKE ALL ON FUNCTION private.applied_migration_versions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.applied_migration_versions()
  TO service_role;

-- -----------------------------------------------------------------------------
-- public wrapper (PostgREST only routes calls to the public schema)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.applied_migration_versions()
RETURNS TABLE(version TEXT, name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY SELECT * FROM private.applied_migration_versions();
END;
$$;

COMMENT ON FUNCTION public.applied_migration_versions() IS
  'PostgREST wrapper for private.applied_migration_versions(). service_role only.';

REVOKE ALL ON FUNCTION public.applied_migration_versions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.applied_migration_versions()
  TO service_role;
