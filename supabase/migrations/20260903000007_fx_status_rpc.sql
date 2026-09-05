-- ===========================================================================
-- The FX staleness signal, reachable from the deploy gate
--
-- Migration: 20260903000007_fx_status_rpc.sql
--
-- 20260903000006 exposed `private.fx_rate_status()` so that "a stale rate warns
-- but does not block" would have somewhere to be READ, and said plainly that
-- without a reader the decision degrades into "does not block".
--
-- The reader is the preflight gate. Every deploy runs it, so the rate's age
-- gets surfaced without anyone remembering to look — which is the whole point,
-- because the thing being watched for is somebody forgetting.
--
-- WHY A WRAPPER AND NOT A DIRECT READ
--
-- The harness could select from `public.fx_rates` and compute the age in
-- TypeScript. That would put the 45-day threshold in two languages, and a
-- threshold maintained in two places is one that will disagree with itself --
-- the same drift argument that put the migration counter under a test rather
-- than in prose. One definition, read by both.
--
-- SECURITY DEFINER over a `private` function, service_role only, matching
-- every other RPC wrapper here. Nothing about rate staleness is customer data,
-- but the rule is that operational surface is not granted to `authenticated`
-- by default, and an exception should be argued for rather than defaulted to.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fx_rate_status()
RETURNS TABLE (
  base_currency CHAR(3),
  quote_currency CHAR(3),
  rate NUMERIC,
  rate_date DATE,
  age_days INTEGER,
  is_stale BOOLEAN,
  source TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT * FROM private.fx_rate_status();
$$;

COMMENT ON FUNCTION public.fx_rate_status IS
  'Deploy-gate view of FX rate freshness. The preflight harness calls this so '
  'that a stale rate is surfaced on every deploy rather than depending on '
  'somebody remembering to check. Warns; never blocks.';

REVOKE ALL ON FUNCTION public.fx_rate_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fx_rate_status() TO service_role;
