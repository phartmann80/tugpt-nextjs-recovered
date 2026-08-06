-- Phase 3B: is_feature_enabled RPC (database source of truth for feature flags)
-- Migration: 20260805000012_create_is_feature_enabled_rpc.sql

CREATE OR REPLACE FUNCTION public.is_feature_enabled(
  p_organization_id UUID,
  p_flag_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    -- Global flag must be true
    (SELECT is_enabled FROM public.feature_flags
     WHERE organization_id IS NULL AND key = p_flag_key)
    AND
    -- AND per-org flag must be true (or missing = false)
    COALESCE(
      (SELECT is_enabled FROM public.feature_flags
       WHERE organization_id = p_organization_id AND key = p_flag_key),
      false
    ),
    false
  );
$$;

-- Service-role only: no anon, no authenticated execution
REVOKE ALL ON FUNCTION public.is_feature_enabled(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_feature_enabled(UUID, TEXT)
  TO service_role;