-- Plans and entitlements.
--
-- ============================================================================
-- WHY THIS IS NOT THE FEATURE-FLAG TABLE WITH A `plan` COLUMN
-- ============================================================================
--
-- ADR-015 D5 decides this and the reasoning is worth restating where the
-- schema lives, because the cheap version is very tempting:
--
--   A feature flag is flipped by an engineer during an incident and must be
--   instantly, globally, obviously off. An entitlement changes when a customer
--   upgrades and must be transactional and auditable against billing.
--
-- Different lifecycles, different blast radii, different people turning the
-- dial. Merged, the failure is a billing change silently disabling a
-- customer's WhatsApp — a support ticket that reads as an outage.
--
-- `packages/feature-flags` already carries a `minimumPlan` field that nothing
-- reads. That field is the merged version, half-built. This migration is the
-- other answer; the field stays unread and should be removed when someone is
-- in that file for another reason.
--
-- ============================================================================
-- LIMITS AND METERS ARE DIFFERENT QUESTIONS
-- ============================================================================
--
-- "How many seats may this organization have" and "how many AI drafts may it
-- generate this month" look alike and are not:
--
--   * A LIMIT is about what exists right now. Removing a seat frees it. The
--     current value is a COUNT of live rows and it can go down.
--   * A METER is about what was consumed within a period. Deleting a draft
--     does not give the tokens back. The current value accumulates and resets
--     only when the period rolls.
--
-- A schema that stores both as "an integer with a maximum" produces "you used
-- 3 seats this month", which is not a sentence about anything. So `kind` is on
-- the metric, it is checked, and `private.current_entitlement_usage` reads a
-- different source per kind.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--
-- 1. **It seeds no plans.** A plan's allowances — how many numbers on free,
--    how many drafts on starter — are product decisions, and inventing
--    plausible numbers here would put them in the schema where they would be
--    read as decided. The catalogue ships empty, resolution fails closed
--    against an empty catalogue (§6), and the pgTAP suite asserts exactly
--    that. What is needed to fill it is one list of plans and allowances.
--
-- 2. **It carries no prices.** A price is a currency, a tax treatment and a
--    billing cycle, and the payment provider is an open owner decision
--    (roadmap §8 row 4). A `price_cents INTEGER` column added now would be
--    wrong in at least the currency, and a wrong column is harder to remove
--    than a missing one is to add.
--
-- 3. **It does not touch `reserve_draft_usage`.** Making the draft quota path
--    read entitlements requires plan rows to exist first, or every draft in
--    every organization is denied the moment it merges. That is the next item
--    (roadmap §5 M2, token+cost accounting), and it is deliberately a separate
--    PR so this one cannot break the pilot.
--
-- 4. **It declares no metric it cannot count.** `ai_cost_cents` is the metric
--    the brief most wants and there is nowhere today that records what a
--    provider call cost. Declaring it now would ship an allowance that is
--    never compared against anything — the shape of the five unread
--    `global_*` seed flags this project already has one of. It arrives with
--    the accounting that can count it.

-- ---------------------------------------------------------------------------
-- 1. The metric vocabulary
-- ---------------------------------------------------------------------------

-- A table rather than a CHECK constraint or an enum, for one reason: a typo in
-- a metric name must be an error, not a new metric. With a free-text column, a
-- plan granting 'whatsapp_number' (singular) grants nothing and denies
-- nothing — it is silently absent, and the organization is limited by a rule
-- nobody can see. The foreign key makes that a write failure.
CREATE TABLE IF NOT EXISTS public.entitlement_metrics (
  key TEXT PRIMARY KEY,

  -- 'limit'  — a maximum number of things that may exist, compared against a
  --            live COUNT. Can go down when things are deleted.
  -- 'meter'  — consumption within a subscription period, compared against an
  --            accumulating total. Does not go down until the period rolls.
  kind TEXT NOT NULL CHECK (kind IN ('limit', 'meter')),

  -- What one unit is, for display. 'seat', 'number', 'draft'. Not an enum:
  -- this is a label, and a wrong label is a cosmetic bug, unlike a wrong key.
  unit TEXT NOT NULL,

  description TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT entitlement_metrics_key_shape
    CHECK (key ~ '^[a-z][a-z0-9_]{2,48}$')
);

COMMENT ON TABLE public.entitlement_metrics IS
  'The things the platform can meter. A metric exists here before any plan can '
  'grant it, so a typo in a plan is a foreign-key failure rather than a silent '
  'absence.';

-- The three metrics that have a real counter today. Each row is paired with a
-- branch of private.current_entitlement_usage; adding a row here without
-- adding that branch is caught by the pgTAP suite, because an uncountable
-- metric is an allowance compared against nothing.
INSERT INTO public.entitlement_metrics (key, kind, unit, description) VALUES
  ('seats', 'limit', 'seat',
   'Members of the organization. Counted from organization_members.'),
  ('whatsapp_numbers', 'limit', 'number',
   'WhatsApp connections in status ''active''. Counted from whatsapp_connections.'),
  ('ai_drafts', 'meter', 'draft',
   'AI drafts generated in the current quota period. Read from draft_usage_tracking.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The plan catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plans (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),

  -- The stable identifier code refers to. Renaming a plan's display name must
  -- not change what a subscription means.
  key TEXT NOT NULL UNIQUE,

  name TEXT NOT NULL,

  -- Whether a signup flow may offer it. A retired plan stays in the table
  -- because organizations are still on it; it just stops being sellable.
  -- Deleting it instead would orphan their subscriptions, and telling a paying
  -- customer their plan no longer exists is not a migration, it is an outage.
  is_available BOOLEAN NOT NULL DEFAULT true,

  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT plans_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{2,48}$'),
  CONSTRAINT plans_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

COMMENT ON TABLE public.plans IS
  'The plan catalogue. Deliberately ships EMPTY: allowances are a product '
  'decision and prices wait on the payment-provider decision. Entitlement '
  'resolution fails closed until rows exist.';

CREATE TRIGGER trigger_plans_updated_at
  BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 3. What a plan grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plan_entitlements (
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  metric TEXT NOT NULL REFERENCES public.entitlement_metrics(key) ON DELETE RESTRICT,

  -- NULL means unlimited, and it is NULL rather than -1 or 2147483647 on
  -- purpose. A sentinel integer is a number that arithmetic will happily use:
  -- `allowance - used` on 2147483647 overflows nothing and looks fine, right
  -- up to a report that says an organization has two billion drafts left.
  -- NULL cannot be accidentally arithmetic'd; every reader must decide what
  -- unlimited means, which is the point.
  allowance INTEGER CHECK (allowance IS NULL OR allowance >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  PRIMARY KEY (plan_id, metric)
);

COMMENT ON COLUMN public.plan_entitlements.allowance IS
  'NULL means unlimited. Not -1, not MAXINT: a sentinel integer participates in '
  'arithmetic and produces plausible nonsense; NULL forces every reader to '
  'handle the case.';

CREATE TRIGGER trigger_plan_entitlements_updated_at
  BEFORE UPDATE ON public.plan_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ON DELETE RESTRICT on the metric, CASCADE on the plan. Deleting a plan takes
-- its grants; deleting a metric that plans still grant would silently widen
-- every one of them to "not granted", so it is refused.

-- ---------------------------------------------------------------------------
-- 4. Which plan an organization is on
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,

  -- 'active'    — entitlements resolve from this plan.
  -- 'past_due'  — still resolves. Payment problems are a dunning question, and
  --               cutting a customer's WhatsApp off the hour an invoice fails
  --               is a decision for a policy, not a side effect of a status
  --               enum. The row is here so that policy has something to read.
  -- 'canceled'  — does not resolve. History, kept.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'canceled')),

  -- The metering window for 'meter' metrics. Nullable because a plan with no
  -- metered entitlement does not need one, and a NOT NULL column would force
  -- every caller to invent a period for a subscription that has no meter.
  current_period_start DATE,
  current_period_end DATE,

  canceled_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT organization_subscriptions_period_pairing
    CHECK ((current_period_start IS NULL) = (current_period_end IS NULL)),
  CONSTRAINT organization_subscriptions_period_order
    CHECK (current_period_end IS NULL OR current_period_end > current_period_start),
  CONSTRAINT organization_subscriptions_canceled_at_pairing
    CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);

-- At most one subscription per organization that resolves. Two active
-- subscriptions is not a state anything downstream can interpret — it is a
-- question ("which plan is this customer on?") with two answers, and the
-- resolution function would silently pick one by row order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_subscriptions_one_resolving
  ON public.organization_subscriptions (organization_id)
  WHERE status IN ('active', 'past_due');

CREATE INDEX IF NOT EXISTS idx_org_subscriptions_plan
  ON public.organization_subscriptions (plan_id);

CREATE TRIGGER trigger_organization_subscriptions_updated_at
  BEFORE UPDATE ON public.organization_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Per-organization overrides
-- ---------------------------------------------------------------------------

-- This table exists because the alternative is worse and certain. Somebody
-- will need to give one customer one extra number — a pilot, an apology, a
-- contract term. Without a place to put it, the edit lands on the plan row,
-- and every organization on that plan gets the extra number. That is a change
-- to hundreds of accounts made by someone who intended to change one, and it
-- is invisible afterwards because the plan looks like it was always that way.
CREATE TABLE IF NOT EXISTS public.organization_entitlement_overrides (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  metric TEXT NOT NULL REFERENCES public.entitlement_metrics(key) ON DELETE RESTRICT,

  allowance INTEGER CHECK (allowance IS NULL OR allowance >= 0),

  -- NOT NULL, and the length check has a floor. An override without a recorded
  -- reason is indistinguishable from a mistake six months later, and the
  -- person who can tell the difference has left. A one-character reason is the
  -- same thing with extra steps, so the floor is 8.
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500),

  -- Nullable: some overrides are permanent (a contract term). An expired
  -- override stops resolving without anyone remembering to delete it, which is
  -- the difference between a trial that ends and a trial that becomes the
  -- price.
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  PRIMARY KEY (organization_id, metric)
);

CREATE TRIGGER trigger_org_entitlement_overrides_updated_at
  BEFORE UPDATE ON public.organization_entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Resolution
-- ---------------------------------------------------------------------------

-- The precedence, in one place so it cannot be reimplemented differently by
-- the second caller:
--
--   1. An unexpired override for this (organization, metric).
--   2. The entitlement on the organization's resolving subscription's plan.
--   3. Nothing — and nothing means DENIED, not unlimited.
--
-- Clause 3 is the one to argue with, so: an organization with no subscription
-- is an organization nobody has decided anything about. Defaulting that to
-- unlimited means a bug in the signup flow hands out an uncapped account, and
-- the way you find out is the invoice. Defaulting it to zero means the same
-- bug is visible on the first action the user takes. Both are bugs; only one
-- is expensive.
--
-- The return is a row rather than a bare integer so that "unlimited" and
-- "denied" are distinguishable — both would be NULL and 0 in an INTEGER
-- return, and a caller reading `COALESCE(allowance, 0)` would turn unlimited
-- into denied.
CREATE TYPE private.entitlement_resolution AS (
  granted BOOLEAN,     -- false = no entitlement at all; the answer is no
  allowance INTEGER,   -- NULL with granted=true means unlimited
  source TEXT          -- 'override' | 'plan' | 'none' — for support, and for §7
);

CREATE OR REPLACE FUNCTION private.resolve_entitlement(
  p_organization_id UUID,
  p_metric TEXT
)
RETURNS private.entitlement_resolution
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_result private.entitlement_resolution;
  v_found BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.entitlement_metrics WHERE key = p_metric) THEN
    RAISE EXCEPTION 'UNKNOWN_ENTITLEMENT_METRIC: %', p_metric
      USING ERRCODE = 'P3F01';
  END IF;

  -- 1. Override.
  SELECT true, o.allowance, 'override'
    INTO v_found, v_result.allowance, v_result.source
  FROM public.organization_entitlement_overrides o
  WHERE o.organization_id = p_organization_id
    AND o.metric = p_metric
    AND (o.expires_at IS NULL OR o.expires_at > pg_catalog.now());

  IF v_found THEN
    v_result.granted := true;
    RETURN v_result;
  END IF;

  -- 2. The plan on the resolving subscription.
  SELECT true, pe.allowance, 'plan'
    INTO v_found, v_result.allowance, v_result.source
  FROM public.organization_subscriptions s
  JOIN public.plan_entitlements pe ON pe.plan_id = s.plan_id
  WHERE s.organization_id = p_organization_id
    AND s.status IN ('active', 'past_due')
    AND pe.metric = p_metric;

  IF v_found THEN
    v_result.granted := true;
    RETURN v_result;
  END IF;

  -- 3. Nothing.
  v_result.granted := false;
  v_result.allowance := 0;
  v_result.source := 'none';
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. What the organization is currently using
-- ---------------------------------------------------------------------------

-- One branch per metric, and the pgTAP suite asserts the branches and the
-- rows in entitlement_metrics are the same set. A metric with no branch is an
-- allowance compared against nothing, which passes every check forever.
CREATE OR REPLACE FUNCTION private.current_entitlement_usage(
  p_organization_id UUID,
  p_metric TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_used INTEGER;
BEGIN
  CASE p_metric
    WHEN 'seats' THEN
      SELECT count(*)::int INTO v_used
      FROM public.organization_members
      WHERE organization_id = p_organization_id;

    WHEN 'whatsapp_numbers' THEN
      SELECT count(*)::int INTO v_used
      FROM public.whatsapp_connections
      WHERE organization_id = p_organization_id
        AND status = 'active';

    WHEN 'ai_drafts' THEN
      -- The meter reads the CURRENT period only. Summing every period would
      -- make a monthly allowance behave like a lifetime one — the customer
      -- would be cut off in month three of a plan they are paying for
      -- monthly.
      SELECT COALESCE(sum(t.draft_count + t.reserved_count), 0)::int INTO v_used
      FROM public.draft_usage_tracking t
      WHERE t.organization_id = p_organization_id
        AND CURRENT_DATE >= t.period_start
        AND CURRENT_DATE <  t.period_end;

    ELSE
      RAISE EXCEPTION 'UNCOUNTABLE_ENTITLEMENT_METRIC: %', p_metric
        USING ERRCODE = 'P3F02';
  END CASE;

  RETURN COALESCE(v_used, 0);
END;
$$;

COMMENT ON FUNCTION private.current_entitlement_usage(UUID, TEXT) IS
  'Current value for a metric. Raises P3F02 for a metric with no branch, '
  'rather than returning 0 — a metric that always reads zero is an allowance '
  'that can never be exceeded, which is worse than an error.';

-- ---------------------------------------------------------------------------
-- 8. The question callers actually ask
-- ---------------------------------------------------------------------------

CREATE TYPE private.entitlement_check AS (
  allowed BOOLEAN,
  allowance INTEGER,   -- NULL = unlimited
  used INTEGER,
  reason TEXT          -- 'ok' | 'unlimited' | 'not_granted' | 'exceeded'
);

-- `p_additional` is how many units the caller is about to consume. Asking
-- "am I under the limit" and then consuming is a different question from
-- "may I consume one more", and the gap between them is the off-by-one that
-- lets an organization onto seat N+1.
CREATE OR REPLACE FUNCTION private.check_entitlement(
  p_organization_id UUID,
  p_metric TEXT,
  p_additional INTEGER DEFAULT 1
)
RETURNS private.entitlement_check
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_res private.entitlement_resolution;
  v_out private.entitlement_check;
BEGIN
  IF p_additional < 0 THEN
    RAISE EXCEPTION 'NEGATIVE_ENTITLEMENT_DELTA: %', p_additional
      USING ERRCODE = 'P3F03';
  END IF;

  v_res := private.resolve_entitlement(p_organization_id, p_metric);
  v_out.used := private.current_entitlement_usage(p_organization_id, p_metric);
  v_out.allowance := v_res.allowance;

  IF NOT v_res.granted THEN
    v_out.allowed := false;
    v_out.reason := 'not_granted';
  ELSIF v_res.allowance IS NULL THEN
    v_out.allowed := true;
    v_out.reason := 'unlimited';
  ELSIF v_out.used + p_additional <= v_res.allowance THEN
    v_out.allowed := true;
    v_out.reason := 'ok';
  ELSE
    v_out.allowed := false;
    v_out.reason := 'exceeded';
  END IF;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. The reader the product needs
-- ---------------------------------------------------------------------------

-- "You are on Free, using 3 of 5 numbers" is a screen, so it needs a call a
-- member can make. SECURITY DEFINER with the membership check inside, rather
-- than RLS on the tables: the answer is computed from four tables, two of
-- which (plans, plan_entitlements) are platform data that no organization
-- should be able to enumerate. A view with RLS would either leak the
-- catalogue or need a policy per table saying the same thing four times.
CREATE OR REPLACE FUNCTION public.organization_entitlements(
  p_organization_id UUID
)
RETURNS TABLE (
  metric TEXT,
  kind TEXT,
  unit TEXT,
  granted BOOLEAN,
  allowance INTEGER,
  used INTEGER,
  source TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = 'P3F04';
  END IF;

  RETURN QUERY
  SELECT m.key,
         m.kind,
         m.unit,
         (private.resolve_entitlement(p_organization_id, m.key)).granted,
         (private.resolve_entitlement(p_organization_id, m.key)).allowance,
         private.current_entitlement_usage(p_organization_id, m.key),
         (private.resolve_entitlement(p_organization_id, m.key)).source
  FROM public.entitlement_metrics m
  ORDER BY m.key;
END;
$$;

COMMENT ON FUNCTION public.organization_entitlements(UUID) IS
  'Resolved entitlements and current usage for one organization. Members only '
  '(P3F04). Never exposes the plan catalogue itself.';

-- ---------------------------------------------------------------------------
-- 10. Access
-- ---------------------------------------------------------------------------

-- Every table here is operational: written by billing and support paths that
-- do not exist yet, read by the definer functions above. The application role
-- gets no direct access to any of it, which is the same posture as
-- draft_quota_limits — and for the same reason, since this is the table an
-- organization would most like to edit.
--
-- FORCE ROW LEVEL SECURITY on all five: without FORCE, the table owner
-- bypasses its own policies, and these tables are owned by the role the
-- definer functions run as.

ALTER TABLE public.entitlement_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_entitlement_overrides FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.entitlement_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plans TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_entitlements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_entitlement_overrides TO service_role;

REVOKE ALL ON public.entitlement_metrics FROM authenticated, anon;
REVOKE ALL ON public.plans FROM authenticated, anon;
REVOKE ALL ON public.plan_entitlements FROM authenticated, anon;
REVOKE ALL ON public.organization_subscriptions FROM authenticated, anon;
REVOKE ALL ON public.organization_entitlement_overrides FROM authenticated, anon;

-- The private functions are reached through the public reader or by
-- service_role. Not callable by the application directly: resolve_entitlement
-- takes an organization_id and does not check membership, because its caller
-- is expected to have done so — which is only safe while nobody untrusted can
-- call it.
REVOKE ALL ON FUNCTION private.resolve_entitlement(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.current_entitlement_usage(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.check_entitlement(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.resolve_entitlement(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION private.current_entitlement_usage(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION private.check_entitlement(UUID, TEXT, INTEGER) TO service_role;

-- The public reader does check membership, so it is the one the app may call.
REVOKE ALL ON FUNCTION public.organization_entitlements(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organization_entitlements(UUID)
  TO authenticated, service_role;
