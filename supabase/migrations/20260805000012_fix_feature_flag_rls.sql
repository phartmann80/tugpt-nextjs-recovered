-- Phase 3B: Fix feature_flags RLS for global (org_id IS NULL) rows
-- Migration: 20260805000012_fix_feature_flag_rls.sql
--
-- SECURITY MODEL:
-- - Global rows (organization_id IS NULL) are service-role/platform-only.
--   Organization owners and admins may NOT create or modify global rows.
-- - Organization owners and admins may manage only their own organization-scoped rows.
-- - Authenticated members can read their own organization flags + global flags.
-- - anon cannot read or write any flags.

-- Drop the existing "manage" policy (it incorrectly allows global flag management by org owners/admins)
DROP POLICY IF EXISTS "Owners and Admins can manage feature flags"
  ON public.feature_flags;

-- Drop the existing SELECT policy to replace with a stricter version
DROP POLICY IF EXISTS "Members can view feature flags for their organization"
  ON public.feature_flags;

-- SELECT policy: authenticated members can read ONLY their own org-scoped flags.
-- Global rows (organization_id IS NULL) are service-role/platform-only.
-- Authenticated users may NOT read global feature flags.
CREATE POLICY "Members can read feature flags"
  ON public.feature_flags FOR SELECT
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND private.is_org_member(organization_id, auth.uid())
  );

-- Manage policy: owners/admins can manage ONLY their own organization-scoped rows
-- Global rows (organization_id IS NULL) are explicitly excluded
CREATE POLICY "Owners and Admins can manage org-scoped feature flags"
  ON public.feature_flags FOR ALL
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::public.organization_role[])
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::public.organization_role[])
  );

-- anon SELECT policy: explicitly deny (no policy = no access for anon)
-- The original schema granted SELECT to anon, but feature flags should not be
-- readable by anonymous users. We revoke that grant.
REVOKE SELECT ON public.feature_flags FROM anon;

-- Grant service_role full access to feature_flags (needed for global flag management)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_flags TO service_role;

-- Service role policy: can manage all feature flags including global rows
CREATE POLICY "Service role can manage all feature flags"
  ON public.feature_flags FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);