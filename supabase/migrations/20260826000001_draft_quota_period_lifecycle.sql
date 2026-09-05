-- M0: draft quota period lifecycle
-- Migration: 20260826000001_draft_quota_period_lifecycle.sql
--
-- WHY THIS EXISTS
--
-- `reserve_draft_usage` resolves an active quota period and denies with
-- DENIED / NO_ACTIVE_QUOTA_PERIOD when no `draft_quota_limits` row covers
-- CURRENT_DATE (see 20260805000015, step 3). Until this migration, nothing in
-- production ever wrote that table. The only writer in the repository was the
-- E2E harness (`apps/worker/src/e2e/milestone1.ts`), which seeds a row for its
-- own test org.
--
-- The consequence was total rather than partial: enabling `ai_draft_generation`
-- for a pilot organization would have denied every job for that org
-- immediately, with no partial success to learn from.
--
-- The harness has known this since it was written — its step 7 creates the
-- quota period *before* its step 8 touches the flags, and says why in a
-- comment. This migration turns that convention into something the database
-- enforces, so it holds for every caller and not just the one that remembered.
--
-- WHAT IT ADDS
--
--   1. private.assert_draft_quota_period_exists()  — trigger function
--   2. trigger_require_draft_quota_before_enable   — on public.feature_flags
--   3. public.ensure_draft_quota_period(...)       — idempotent period creation
--   4. public.enable_draft_generation_for_org(...) — quota + org flag, atomic
--   5. public.disable_draft_generation_for_org(...)— the rollback path
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
-- It never touches the GLOBAL `ai_draft_generation` row (organization_id IS
-- NULL). `is_feature_enabled` ANDs global with per-org, so no draft is
-- generated for anybody while the global row is false. That keeps the global
-- flip a separate, supervised, owner-held act: these RPCs prepare
-- organizations, and the owner decides when generation actually starts. Running
-- `enable_draft_generation_for_org` for every pilot org changes no behaviour
-- until that happens.

-- =============================================================================
-- 1. Trigger function: enabling requires a covering quota period
-- =============================================================================
--
-- This encodes a PRECONDITION, not the current state: "turning
-- `ai_draft_generation` on for an organization requires that organization to
-- have a quota period covering today." Written that way it needs no edit when
-- quota seeding becomes part of onboarding — it simply stops objecting.
--
-- Three deliberate exemptions:
--
--   * The global row (organization_id IS NULL) is exempt. There is no
--     organization whose quota could be checked, and that row is the owner's
--     supervised switch.
--
--   * Only the transition to enabled is checked. A row that is already enabled
--     can still be updated — otherwise an unrelated `rules` edit would start
--     failing the moment a period lapsed at month end, which is both surprising
--     and the wrong place to surface it. A lapse mid-flight is already handled,
--     correctly and loudly, by reserve_draft_usage returning
--     NO_ACTIVE_QUOTA_PERIOD.
--
--   * Other flag keys are untouched. In particular this says nothing about
--     `whatsapp_integration`, whose dual enforcement (database row AND the
--     hardcoded false in packages/feature-flags/src/flags.ts) is unchanged.
CREATE OR REPLACE FUNCTION private.assert_draft_quota_period_exists()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- Not the key this guard is about.
  IF NEW.key <> 'ai_draft_generation' THEN
    RETURN NEW;
  END IF;

  -- The global row: the owner's supervised switch, no org to check.
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only enabling is guarded.
  IF NOT NEW.is_enabled THEN
    RETURN NEW;
  END IF;

  -- Already enabled: this update is not the transition we guard.
  IF TG_OP = 'UPDATE' AND OLD.is_enabled THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.draft_quota_limits
    WHERE organization_id = NEW.organization_id
      AND CURRENT_DATE >= period_start
      AND CURRENT_DATE <  period_end
  ) THEN
    RAISE EXCEPTION 'DRAFT_QUOTA_PERIOD_REQUIRED'
      USING ERRCODE = 'P3B17',
            DETAIL  = format(
              'Organization %s has no draft_quota_limits row covering %s.',
              NEW.organization_id, CURRENT_DATE
            ),
            HINT    = 'Call public.enable_draft_generation_for_org(org_id, hard_ceiling), '
                      'which creates the quota period and enables the flag in one transaction. '
                      'Enabling the flag alone would make reserve_draft_usage deny every job '
                      'with NO_ACTIVE_QUOTA_PERIOD.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_require_draft_quota_before_enable
  BEFORE INSERT OR UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION private.assert_draft_quota_period_exists();

-- =============================================================================
-- 2. ensure_draft_quota_period — idempotent, overlap-safe
-- =============================================================================
--
-- PERIOD SHAPE: calendar month, [first of this month, first of next month).
--
-- Chosen over a rolling 30-day window because billing is what this becomes:
-- when M2 introduces plans and entitlements, a quota period will be driven by a
-- subscription, and subscriptions bill on calendar or anniversary boundaries,
-- not on "30 days after somebody ran a script". A calendar month is also
-- trivially predictable when reading a table by hand at 2am, which is the
-- condition under which people actually read this table.
--
-- IDEMPOTENCE AND THE EXCLUSION CONSTRAINT: draft_quota_limits carries a gist
-- EXCLUDE on (organization_id, daterange(period_start, period_end)), so an
-- overlapping insert is a hard error. This function therefore inserts only when
-- NOTHING covers today, and otherwise returns the covering row untouched. Two
-- useful consequences:
--
--   * Calling it repeatedly is safe.
--   * It interoperates with the E2E harness's rolling 30-day period rather than
--     colliding with it — if the harness got there first, its period covers
--     today and this returns that row.
--
-- An existing covering period is NEVER silently re-ceilinged. Changing a live
-- organization's ceiling mid-period is a deliberate act with billing meaning;
-- it does not belong in a function whose job is "make sure one exists".
CREATE OR REPLACE FUNCTION public.ensure_draft_quota_period(
  p_organization_id UUID,
  p_hard_ceiling    INTEGER,
  OUT quota_limit_id UUID,
  OUT period_start   DATE,
  OUT period_end     DATE,
  OUT hard_ceiling   INTEGER,
  OUT created        BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_start DATE;
  v_end   DATE;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ORGANIZATION_REQUIRED' USING ERRCODE = 'P3B17';
  END IF;

  IF p_hard_ceiling IS NULL OR p_hard_ceiling < 0 THEN
    RAISE EXCEPTION 'INVALID_HARD_CEILING'
      USING ERRCODE = 'P3B17',
            DETAIL  = 'hard_ceiling must be a non-negative integer.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND' USING ERRCODE = 'P3B17';
  END IF;

  -- Lock any covering row so two concurrent callers cannot both decide to
  -- insert. Without FOR UPDATE this is a race the exclusion constraint would
  -- catch as an error rather than as idempotence.
  SELECT l.id, l.period_start, l.period_end, l.hard_ceiling
    INTO quota_limit_id, period_start, period_end, hard_ceiling
  FROM public.draft_quota_limits AS l
  WHERE l.organization_id = p_organization_id
    AND CURRENT_DATE >= l.period_start
    AND CURRENT_DATE <  l.period_end
  ORDER BY l.period_start DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    created := false;
    RETURN;
  END IF;

  v_start := date_trunc('month', CURRENT_DATE)::DATE;
  v_end   := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE;

  INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
  VALUES (p_organization_id, v_start, v_end, p_hard_ceiling)
  RETURNING id, draft_quota_limits.period_start, draft_quota_limits.period_end, draft_quota_limits.hard_ceiling
    INTO quota_limit_id, period_start, period_end, hard_ceiling;

  created := true;
  RETURN;
END;
$$;

-- =============================================================================
-- 3. enable_draft_generation_for_org — the sanctioned path
-- =============================================================================
--
-- Quota period and org flag in one transaction. The trigger above makes the
-- reverse order impossible, so there is no way to end up with a flag on and no
-- quota — through this function or around it.
--
-- Still gated by the global row: nothing generates until the owner flips it.
CREATE OR REPLACE FUNCTION public.enable_draft_generation_for_org(
  p_organization_id UUID,
  p_hard_ceiling    INTEGER,
  OUT quota_limit_id     UUID,
  OUT period_start       DATE,
  OUT period_end         DATE,
  OUT hard_ceiling       INTEGER,
  OUT quota_created      BOOLEAN,
  OUT org_flag_enabled   BOOLEAN,
  OUT global_flag_enabled BOOLEAN,
  OUT effective          BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_quota RECORD;
BEGIN
  SELECT * INTO v_quota
  FROM public.ensure_draft_quota_period(p_organization_id, p_hard_ceiling);

  quota_limit_id := v_quota.quota_limit_id;
  period_start   := v_quota.period_start;
  period_end     := v_quota.period_end;
  hard_ceiling   := v_quota.hard_ceiling;
  quota_created  := v_quota.created;

  INSERT INTO public.feature_flags (organization_id, key, is_enabled)
  VALUES (p_organization_id, 'ai_draft_generation', true)
  ON CONFLICT (organization_id, key)
  DO UPDATE SET is_enabled = true, updated_at = now();

  org_flag_enabled := true;

  SELECT COALESCE(f.is_enabled, false) INTO global_flag_enabled
  FROM public.feature_flags AS f
  WHERE f.organization_id IS NULL AND f.key = 'ai_draft_generation';
  global_flag_enabled := COALESCE(global_flag_enabled, false);

  -- What is_feature_enabled will actually answer. Surfaced so an operator can
  -- see at a glance that preparing an org did not, by itself, start anything.
  effective := public.is_feature_enabled(p_organization_id, 'ai_draft_generation');

  RETURN;
END;
$$;

-- =============================================================================
-- 4. disable_draft_generation_for_org — the rollback path
-- =============================================================================
--
-- Turns the org flag off and leaves draft_quota_limits alone. Quota rows carry
-- consumed usage for the period and are referenced by usage tracking and
-- reservations; deleting them on a rollback would destroy the record of what
-- the pilot actually did, which is the one thing a rollback most needs to keep.
CREATE OR REPLACE FUNCTION public.disable_draft_generation_for_org(
  p_organization_id UUID,
  OUT org_flag_enabled BOOLEAN,
  OUT effective        BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ORGANIZATION_REQUIRED' USING ERRCODE = 'P3B17';
  END IF;

  INSERT INTO public.feature_flags (organization_id, key, is_enabled)
  VALUES (p_organization_id, 'ai_draft_generation', false)
  ON CONFLICT (organization_id, key)
  DO UPDATE SET is_enabled = false, updated_at = now();

  org_flag_enabled := false;
  effective := public.is_feature_enabled(p_organization_id, 'ai_draft_generation');
  RETURN;
END;
$$;

-- =============================================================================
-- 5. Grants — service_role only, matching every other operational RPC
-- =============================================================================
REVOKE ALL ON FUNCTION public.ensure_draft_quota_period(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_draft_quota_period(UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.enable_draft_generation_for_org(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enable_draft_generation_for_org(UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.disable_draft_generation_for_org(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disable_draft_generation_for_org(UUID)
  TO service_role;
