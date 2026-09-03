-- Token and cost accounting.
--
-- ============================================================================
-- THE GAP THIS CLOSES
-- ============================================================================
--
-- Every adapter already computes token usage. `CompletionResponse.usage`
-- carries promptTokens/completionTokens/totalTokens (adapter.ts:41-45), and
-- langdock.ts:151-153, anymize.ts:130-132 and logicc.ts:80-81 each populate it
-- from the provider's own response.
--
-- The worker then throws it away. `grep usage apps/worker/src/draft-worker.ts`
-- matches only `reserve_draft_usage`, the request-count quota RPC. The numbers
-- are measured on every single draft and discarded.
--
-- So the instrumentation reaches the provider boundary and stops one layer
-- short of a table. That is what this migration adds, and it is why the item
-- is small relative to what it unlocks.
--
-- What the quota system counts today is `draft_count` against `hard_ceiling`:
-- one integer, one dimension. ADR-015 D5 says plainly that this cannot express
-- any tier worth selling, and the brief asks for metering "per org, per
-- Employee, per feature, per modality" — four dimensions, of which the current
-- system has none.
--
-- ============================================================================
-- SHAPED FOR AUDIO FROM THE START, NOT RETROFITTED
-- ============================================================================
--
-- A voice-transcription provider is approved and coming. Its cost is priced
-- per second of audio, not per token, and designing the token table first and
-- widening it later is how a schema ends up with six nullable columns that are
-- each meaningful for one modality.
--
-- Two facts about per-second audio pricing shaped this:
--
--   1. **The provider decides the billed quantity, and it is not the duration.**
--      Gladia's result metadata defines `billing_time` as
--      `audio_duration * number_of_distinct_channels` — a stereo file bills
--      twice its length. A model that stored "seconds of audio" and multiplied
--      by the rate would understate every stereo recording by 100%, and the
--      way anyone would find out is the invoice. So the rule here, which
--      generalises past this one provider: **record the quantity the provider
--      says it will bill.** `audio_duration` is kept beside it as metadata
--      precisely so the difference stays visible.
--
--   2. **Granularity is not fussiness.** At the approved rate, a 15-second
--      voice note and a 10-minute recording differ by 40x. A request counter
--      cannot tell them apart at all, which is D2's argument made concrete.
--
-- ============================================================================
-- WHY TWO TABLES
-- ============================================================================
--
-- The tempting single table has `input_units` and `output_units`. It breaks on
-- the first honest question: a text call bills input and output at DIFFERENT
-- rates, so one row cannot carry one price. Widening to input_price/
-- output_price works until the third dimension arrives — images per unit,
-- video per second, a per-request fee — and each one is another pair of
-- columns that is NULL for every other modality.
--
-- A child table costs one join and stops that.

-- ---------------------------------------------------------------------------
-- 1. The price book
-- ---------------------------------------------------------------------------

-- Prices live in a table, not in configuration, for one reason: the rate is
-- COPIED onto the usage row at write time, so history is immutable — but the
-- current rate still has to come from somewhere auditable. A rate in an
-- environment variable is a number nobody reviewed and nobody can diff.
CREATE TABLE IF NOT EXISTS public.provider_prices (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),

  provider TEXT NOT NULL,

  -- NULL means "any model from this provider". Transcription has one price
  -- across models; chat completion does not. A sentinel string like '*' would
  -- be a model name that could collide with a real one.
  model TEXT,

  dimension TEXT NOT NULL
    CHECK (dimension IN ('input_tokens', 'output_tokens', 'audio_seconds')),

  -- NUMERIC, not an integer of micro-units. $0.61/hour is 169.444...  µUSD per
  -- second: exact in NUMERIC, lossy in any integer unit. The rounding happens
  -- once, at the recorded cost, where it is worth at most one millionth of a
  -- dollar per row.
  unit_price NUMERIC(20, 10) NOT NULL CHECK (unit_price >= 0),

  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),

  effective_from TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  -- NULL means "still in effect".
  effective_to TIMESTAMPTZ,

  -- Where the number came from. A price with no provenance is a price nobody
  -- can re-verify when the vendor changes their page.
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 8 AND 300),

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT provider_prices_period_order
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- No two prices for the same key may overlap in time. Without this, resolution
-- picks one by row order and the cost of a call depends on insert sequence —
-- which is the kind of bug that is invisible until an invoice is disputed.
--
-- COALESCE on model because NULL is a real value here ("any model") and
-- `WITH =` does not match NULL to NULL.
ALTER TABLE public.provider_prices
  ADD CONSTRAINT provider_prices_no_overlap
  EXCLUDE USING gist (
    provider WITH =,
    COALESCE(model, '') WITH =,
    dimension WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  );

CREATE INDEX IF NOT EXISTS idx_provider_prices_lookup
  ON public.provider_prices (provider, dimension, effective_from DESC);

CREATE TRIGGER trigger_provider_prices_updated_at
  BEFORE UPDATE ON public.provider_prices
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.provider_prices IS
  'Effective-dated provider rates. Ships EMPTY: a wrong price is worse than a '
  'missing one, because a missing price makes cost visibly unknown while a '
  'wrong price makes it plausibly wrong.';

-- Deliberately no rows. Langdock''s per-model rates are not known here, and
-- the transcription rate belongs with the adapter that will use it. An
-- unpriced call is recorded with a NULL cost and counted as unpriced (§4), not
-- silently valued at zero.

-- ---------------------------------------------------------------------------
-- 2. What happened
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_usage_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  -- A CHECK rather than a vocabulary table, unlike entitlement_metrics. The
  -- difference is the failure: a typo'd metric key silently grants nothing and
  -- limits an organization by an invisible rule, whereas a typo'd modality
  -- mis-categorises a row that is still counted. CHECK catches it at the write
  -- either way, and this set is small and code-coupled.
  modality TEXT NOT NULL CHECK (modality IN ('text', 'audio')),

  -- As REPORTED by the adapter, not as configured. Under rotation the model
  -- that answered is not always the model that was asked for, and the cost
  -- follows the one that answered.
  provider TEXT NOT NULL,
  model TEXT,

  -- The provider's own identifier for the call. Without it an invoice line
  -- cannot be matched back to a row, which is the entire point of keeping
  -- these.
  provider_reference TEXT,

  -- Ties the row to the structured logs (D5).
  request_id TEXT,

  -- Attribution. "Which draft cost this" has to be answerable, and a
  -- foreign key rather than a loose UUID means it stays answerable.
  draft_generation_job_id UUID
    REFERENCES public.draft_generation_jobs(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,

  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),

  -- NULLABLE, and that is the interesting decision — see §4.
  --
  -- Micro-units of currency, not cents: a 15-second voice note costs about
  -- 2,542 µUSD, and cents would round it to zero. An organization's whole
  -- month of voice notes would then cost nothing at all.
  cost_micros BIGINT CHECK (cost_micros IS NULL OR cost_micros >= 0),

  -- Free-form, small, and NOT a place for customer content. `audio_duration`
  -- lives here beside a billed `audio_seconds` component precisely so the
  -- difference between measured and billed stays visible (see the header).
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- The index the cost meter reads: one organization, one period.
CREATE INDEX IF NOT EXISTS idx_provider_usage_events_org_time
  ON public.provider_usage_events (organization_id, occurred_at DESC);

-- The index the "what is unpriced" report reads. Partial, because in a healthy
-- system almost no rows match and a full index would be mostly waste.
CREATE INDEX IF NOT EXISTS idx_provider_usage_events_unpriced
  ON public.provider_usage_events (organization_id, occurred_at DESC)
  WHERE cost_micros IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_usage_events_job
  ON public.provider_usage_events (draft_generation_job_id)
  WHERE draft_generation_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Why it cost that
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_usage_components (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  event_id UUID NOT NULL
    REFERENCES public.provider_usage_events(id) ON DELETE CASCADE,

  dimension TEXT NOT NULL
    CHECK (dimension IN ('input_tokens', 'output_tokens', 'audio_seconds')),

  quantity BIGINT NOT NULL CHECK (quantity >= 0),

  -- The rate AT THE TIME OF THE CALL, copied onto the row. A join to
  -- provider_prices would re-price history every time a vendor changes their
  -- rates, so last month's invoice would stop reconciling the moment this
  -- month's price landed.
  unit_price NUMERIC(20, 10) CHECK (unit_price IS NULL OR unit_price >= 0),

  cost_micros BIGINT CHECK (cost_micros IS NULL OR cost_micros >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  -- Price and cost are known together or not at all.
  CONSTRAINT provider_usage_components_pricing_pairing
    CHECK ((unit_price IS NULL) = (cost_micros IS NULL)),

  -- One row per dimension per event. Two 'input_tokens' rows on one event is
  -- not a richer record, it is a double charge.
  CONSTRAINT provider_usage_components_one_per_dimension
    UNIQUE (event_id, dimension)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_components_event
  ON public.provider_usage_components (event_id);

-- ---------------------------------------------------------------------------
-- 4. The total has to be defensible
-- ---------------------------------------------------------------------------

-- An event's cost must equal the sum of its components'. Written as a
-- constraint rather than a comment, because a total nobody can reconstruct is
-- a number that cannot be defended in a billing dispute — and the day it needs
-- defending is a day a customer is already angry.
--
-- DEFERRABLE INITIALLY DEFERRED because components are inserted after their
-- event: an immediate check would fail on the event's own INSERT, when it has
-- no components yet.
CREATE OR REPLACE FUNCTION private.assert_usage_event_total()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_event_id UUID;
  v_event_cost BIGINT;
  v_sum BIGINT;
  v_unpriced INTEGER;
BEGIN
  v_event_id := COALESCE(NEW.id, OLD.id);
  IF TG_TABLE_NAME = 'provider_usage_components' THEN
    v_event_id := COALESCE(NEW.event_id, OLD.event_id);
  END IF;

  SELECT cost_micros INTO v_event_cost
  FROM public.provider_usage_events WHERE id = v_event_id;

  -- The event was deleted in this transaction; its components went with it.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(cost_micros), 0), count(*) FILTER (WHERE cost_micros IS NULL)
    INTO v_sum, v_unpriced
  FROM public.provider_usage_components WHERE event_id = v_event_id;

  -- An UNPRICED event is a real record with an unknown cost, not a free one.
  -- See the comment on record_provider_usage: dropping the usage because the
  -- price is missing loses the only evidence that the call happened, and
  -- valuing it at zero silently under-reports the organization's consumption
  -- to the entitlement meter. So: if any component is unpriced, the event's
  -- cost must be NULL — visibly unknown, and countable as such.
  IF v_unpriced > 0 THEN
    IF v_event_cost IS NOT NULL THEN
      RAISE EXCEPTION
        'usage event % has unpriced components but a non-null cost', v_event_id
        USING ERRCODE = 'P3G01';
    END IF;
    RETURN NULL;
  END IF;

  IF v_event_cost IS DISTINCT FROM v_sum THEN
    RAISE EXCEPTION
      'usage event % cost % does not equal its components'' sum %',
      v_event_id, v_event_cost, v_sum
      USING ERRCODE = 'P3G02';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER provider_usage_events_total_matches
  AFTER INSERT OR UPDATE ON public.provider_usage_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.assert_usage_event_total();

CREATE CONSTRAINT TRIGGER provider_usage_components_total_matches
  AFTER INSERT OR UPDATE OR DELETE ON public.provider_usage_components
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.assert_usage_event_total();

-- ---------------------------------------------------------------------------
-- 5. Price resolution
-- ---------------------------------------------------------------------------

-- Exact model beats provider-wide. Transcription has one rate across models;
-- chat completion does not, and a provider-wide fallback that outranked an
-- exact match would quietly charge every model the same.
CREATE OR REPLACE FUNCTION private.resolve_provider_price(
  p_provider TEXT,
  p_model TEXT,
  p_dimension TEXT,
  p_at TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT unit_price
  FROM public.provider_prices
  WHERE provider = p_provider
    AND dimension = p_dimension
    AND (model = p_model OR model IS NULL)
    AND effective_from <= p_at
    AND (effective_to IS NULL OR effective_to > p_at)
  ORDER BY (model IS NOT NULL) DESC
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 6. Recording
-- ---------------------------------------------------------------------------

-- Callers pass QUANTITIES; the database resolves the price. The alternative —
-- the worker passing a price it read from config — puts the rate outside the
-- audited table and makes every caller a place the number can be wrong.
--
-- `p_quantities` is {"input_tokens": 1200, "output_tokens": 340} or
-- {"audio_seconds": 137}. JSONB rather than a signature per modality, because
-- the set of dimensions grows and a signature per modality is a migration per
-- modality.
--
-- ON A MISSING PRICE: record the event and its components with NULL cost, and
-- do not raise. The call already happened and the provider will already
-- charge for it — losing the usage record because we cannot value it destroys
-- the only evidence it occurred, and valuing it at zero under-reports the
-- organization's consumption to the entitlement meter. Unpriced rows are
-- visible (idx_provider_usage_events_unpriced) and countable, which is the
-- difference between a known gap and a wrong number.
CREATE OR REPLACE FUNCTION private.record_provider_usage(
  p_organization_id UUID,
  p_modality TEXT,
  p_provider TEXT,
  p_model TEXT,
  p_quantities JSONB,
  p_provider_reference TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_draft_generation_job_id UUID DEFAULT NULL,
  p_message_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_occurred_at TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_event_id UUID;
  v_dim TEXT;
  v_qty BIGINT;
  v_price NUMERIC;
  v_cost BIGINT;
  v_total BIGINT := 0;
  v_any_unpriced BOOLEAN := false;
  v_count INTEGER := 0;
BEGIN
  IF p_quantities IS NULL OR jsonb_typeof(p_quantities) <> 'object'
     OR p_quantities = '{}'::jsonb THEN
    RAISE EXCEPTION 'EMPTY_USAGE_QUANTITIES'
      USING ERRCODE = 'P3G03';
  END IF;

  INSERT INTO public.provider_usage_events (
    organization_id, occurred_at, modality, provider, model,
    provider_reference, request_id, draft_generation_job_id, message_id,
    metadata, cost_micros
  )
  VALUES (
    p_organization_id, p_occurred_at, p_modality, p_provider, p_model,
    p_provider_reference, p_request_id, p_draft_generation_job_id, p_message_id,
    COALESCE(p_metadata, '{}'::jsonb), NULL
  )
  RETURNING id INTO v_event_id;

  FOR v_dim, v_qty IN
    SELECT key, value::text::bigint FROM jsonb_each(p_quantities)
  LOOP
    v_price := private.resolve_provider_price(p_provider, p_model, v_dim, p_occurred_at);

    IF v_price IS NULL THEN
      v_any_unpriced := true;
      v_cost := NULL;
    ELSE
      -- round(), not trunc(): truncation biases every single row downward, and
      -- a systematic undercount across millions of calls is a real number.
      v_cost := round(v_qty::numeric * v_price * 1000000)::bigint;
      v_total := v_total + v_cost;
    END IF;

    INSERT INTO public.provider_usage_components (
      event_id, dimension, quantity, unit_price, cost_micros
    )
    VALUES (v_event_id, v_dim, v_qty, v_price, v_cost);

    v_count := v_count + 1;
  END LOOP;

  IF NOT v_any_unpriced THEN
    UPDATE public.provider_usage_events
    SET cost_micros = v_total
    WHERE id = v_event_id;
  END IF;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION private.record_provider_usage IS
  'Records one provider call and its billed components, pricing them from '
  'provider_prices at the time of the call. A missing price yields a recorded '
  'but unpriced row rather than an error or a zero.';

-- ---------------------------------------------------------------------------
-- 7. The cost meter, wired into entitlements
-- ---------------------------------------------------------------------------

INSERT INTO public.entitlement_metrics (key, kind, unit, description) VALUES
  ('ai_cost_micros', 'meter', 'µUSD',
   'Provider spend in the current subscription period, in micro-USD. Summed '
   'from provider_usage_events; unpriced events are excluded and visible '
   'separately.')
ON CONFLICT (key) DO NOTHING;

-- `current_entitlement_usage` gains a fourth branch. The V3 assertion in
-- plans_and_entitlements.test.sql walks entitlement_metrics and calls this
-- function for every row, so adding the metric WITHOUT this branch fails that
-- suite — which is the guard working exactly as intended, one migration later.
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

    WHEN 'ai_cost_micros' THEN
      -- ADDED BY 20260903000002.
      --
      -- The window is the SUBSCRIPTION's period, not the draft quota's. Those
      -- are different objects with different owners — one is billing, one is
      -- an operational cap — and reading the wrong one would meter spend
      -- against a window the customer is not being billed on.
      --
      -- An organization with no period gets 0, not "everything ever". A spend
      -- meter with no window is a lifetime total, and comparing a lifetime
      -- total against a monthly allowance denies every established customer.
      SELECT COALESCE(sum(e.cost_micros), 0)::int INTO v_used
      FROM public.provider_usage_events e
      JOIN public.organization_subscriptions s
        ON s.organization_id = e.organization_id
       AND s.status IN ('active', 'past_due')
      WHERE e.organization_id = p_organization_id
        AND s.current_period_start IS NOT NULL
        AND e.occurred_at >= s.current_period_start::timestamptz
        AND e.occurred_at <  s.current_period_end::timestamptz;

    ELSE
      RAISE EXCEPTION 'UNCOUNTABLE_ENTITLEMENT_METRIC: %', p_metric
        USING ERRCODE = 'P3F02';
  END CASE;

  RETURN COALESCE(v_used, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Access
-- ---------------------------------------------------------------------------

-- Operational tables, same posture as draft_quota_limits: service_role writes,
-- the application reads nothing directly. FORCE, because the definer functions
-- run as the owner and without FORCE the owner bypasses its own policies.

ALTER TABLE public.provider_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_usage_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_usage_components FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_prices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_usage_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_usage_components TO service_role;

REVOKE ALL ON public.provider_prices FROM authenticated, anon;
REVOKE ALL ON public.provider_usage_events FROM authenticated, anon;
REVOKE ALL ON public.provider_usage_components FROM authenticated, anon;

-- A usage row names a provider, a model and a cost. That is commercial
-- information about how TuGPT is built and what it pays, and no organization
-- needs it to see its own spend — `organization_entitlements` already returns
-- the resolved `ai_cost_micros` total, which is the number a customer is
-- entitled to and the only one they are.
REVOKE ALL ON FUNCTION private.record_provider_usage(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, UUID, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_provider_usage(
  UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, UUID, JSONB, TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION private.resolve_provider_price(TEXT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.resolve_provider_price(TEXT, TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;

REVOKE ALL ON FUNCTION private.assert_usage_event_total()
  FROM PUBLIC, anon, authenticated;
