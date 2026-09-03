-- ===========================================================================
-- FX conversion: the one number that was missing
--
-- Migration: 20260903000006_fx_conversion.sql
--
-- 20260903000005 made the cost meter refuse a period it could not express in
-- the accounting currency, and named what was missing rather than the symptom:
-- "no conversion is configured". This supplies it.
--
-- Paul's decision, 2026-09-03: account EUR->USD at the ECB daily euro
-- reference rate, updated manually, monthly cadence acceptable. A stale rate
-- WARNS but does not BLOCK -- an old official rate beats refusing enforcement
-- entirely.
--
-- ---------------------------------------------------------------------------
-- 1. WHY STALE-BUT-WARNING IS THE RIGHT TRADE, AND WHAT MAKES IT SAFE
-- ---------------------------------------------------------------------------
--
-- Agreed, and the reason is sharper than "some number beats no number": the
-- rate and its date are stored ON EVERY CONVERTED ROW, so staleness can only
-- affect an enforcement DECISION. It can never corrupt what was recorded.
-- Last month's totals stay exactly reproducible from the row itself no matter
-- how old the rate was when it was applied.
--
-- Given that asymmetry the arithmetic is easy. EUR/USD drifts on the order of
-- a couple of percent over 45 days. A spend cap enforced two percent wrong is
-- obviously better than a spend cap not enforced at all, which is what
-- blocking would mean.
--
-- The one caveat worth stating: a WARNING is only as good as whoever reads it.
-- `RAISE WARNING` lands in the worker's log and nowhere a person looks on
-- purpose, so staleness is ALSO exposed as queryable state
-- (`private.fx_rate_status`) precisely so it can be alerted on rather than
-- discovered. Without that, "warn but do not block" degrades into "do not
-- block", which is a different decision than the one that was made.
--
-- ---------------------------------------------------------------------------
-- 2. DATED SNAPSHOTS, NOT EFFECTIVE RANGES
-- ---------------------------------------------------------------------------
--
-- `provider_prices` uses tstzrange with a GiST exclusion because a vendor's
-- price is in force over a period. An ECB reference rate is not that shape: it
-- is a single published value FOR a date, and the rate in force at any moment
-- is simply the most recent published date at or before it.
--
-- So the key is (base, quote, rate_date) and resolution is "latest rate_date
-- <= the instant". Modelling it as ranges would mean inventing an end date for
-- every daily rate, and inventing data is how a price book stops matching its
-- source.
--
-- ---------------------------------------------------------------------------
-- 3. WHAT IS STORED ON EACH EVENT, AND WHY FOUR COLUMNS
-- ---------------------------------------------------------------------------
--
--   accounting_cost_micros  the cost expressed in the accounting currency
--   accounting_currency     which currency that is, copied not assumed
--   fx_rate, fx_rate_date   the rate applied and the date it was published
--
-- `accounting_currency` is copied rather than read from
-- `private.accounting_currency()` at query time for the same reason
-- `unit_price` is copied onto components: the day the platform's accounting
-- currency changes, every historical row must keep meaning what it meant.
--
-- `fx_rate` and `fx_rate_date` are NULL for an event ALREADY in the accounting
-- currency, because no conversion happened and a stored 1.0 would be a
-- conversion that never occurred. That asymmetry is deliberate and the CHECKs
-- below encode it.
--
-- ---------------------------------------------------------------------------
-- 4. THE SEEDED RATE
-- ---------------------------------------------------------------------------
--
--   1 EUR = 1.1578 USD, reference date 2026-09-02
--
-- Read from the ECB's own daily reference feed on 2026-09-03 and cross-checked
-- against the ECB's USD reference-rate page; both gave the same value and the
-- same date.
--
-- The date is 2026-09-02 and not today because the ECB had not yet published
-- 2026-09-03 when this was read. That is the normal state of affairs for most
-- of any given day, and it is exactly why the rate carries its own date rather
-- than being assumed current.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.fx_rates (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),

  base_currency  CHAR(3) NOT NULL CHECK (base_currency  IN ('USD', 'EUR')),
  quote_currency CHAR(3) NOT NULL CHECK (quote_currency IN ('USD', 'EUR')),

  -- 1 base = <rate> quote.
  rate NUMERIC(20, 10) NOT NULL CHECK (rate > 0),

  -- The date the rate was PUBLISHED FOR, not the date it was entered. These
  -- differ by at least a day in normal operation and that difference is the
  -- whole point of the column.
  rate_date DATE NOT NULL,

  -- Provenance, same rule as provider_prices: a rate nobody can re-verify is a
  -- rate nobody can defend.
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 8 AND 300),

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  -- A currency does not need a stored rate against itself; identity is handled
  -- in code so that USD->USD works with an empty table.
  CONSTRAINT fx_rates_not_identity CHECK (base_currency <> quote_currency),
  CONSTRAINT fx_rates_one_per_day  UNIQUE (base_currency, quote_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup
  ON public.fx_rates (base_currency, quote_currency, rate_date DESC);

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.fx_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fx_rates TO service_role;

COMMENT ON TABLE public.fx_rates IS
  'Dated FX snapshots. 1 base_currency = rate quote_currency on rate_date. '
  'ECB daily euro reference rates, entered manually. The rate in force at an '
  'instant is the most recent rate_date at or before it.';

-- ---------------------------------------------------------------------------
-- How stale is too stale
-- ---------------------------------------------------------------------------

-- 45 days, per the 2026-09-03 decision. A function rather than a literal so
-- the threshold is greppable and changes in one place.
CREATE OR REPLACE FUNCTION private.fx_rate_max_age_days()
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 45 $$;

CREATE OR REPLACE FUNCTION private.resolve_fx_rate(
  p_from CHAR(3),
  p_to   CHAR(3),
  p_at   TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS TABLE (rate NUMERIC, rate_date DATE)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  -- Identity first, and without touching the table: a database with no rates
  -- at all must still be able to account USD spend in USD. Returning NULL
  -- here would make the meter refuse every organization on day one.
  SELECT 1::numeric, (p_at AT TIME ZONE 'UTC')::date
  WHERE p_from = p_to
  UNION ALL
  SELECT f.rate, f.rate_date
  FROM public.fx_rates f
  WHERE p_from <> p_to
    AND f.base_currency = p_from
    AND f.quote_currency = p_to
    AND f.rate_date <= (p_at AT TIME ZONE 'UTC')::date
  ORDER BY 2 DESC
  LIMIT 1;
$$;

-- Queryable staleness, so "warn but do not block" has somewhere to be read.
-- Returns one row per currency pair actually needed to account provider spend.
CREATE OR REPLACE FUNCTION private.fx_rate_status()
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
  SELECT DISTINCT ON (f.base_currency, f.quote_currency)
    f.base_currency,
    f.quote_currency,
    f.rate,
    f.rate_date,
    (CURRENT_DATE - f.rate_date)::int,
    (CURRENT_DATE - f.rate_date) > private.fx_rate_max_age_days(),
    f.source
  FROM public.fx_rates f
  ORDER BY f.base_currency, f.quote_currency, f.rate_date DESC;
$$;

COMMENT ON FUNCTION private.fx_rate_status IS
  'The current rate per pair with its age. A stale rate warns rather than '
  'blocking (2026-09-03 decision), so this exists to make staleness something '
  'an operator can alert on instead of something they discover.';

-- ---------------------------------------------------------------------------
-- The event carries its own conversion
-- ---------------------------------------------------------------------------

ALTER TABLE public.provider_usage_events
  ADD COLUMN IF NOT EXISTS accounting_cost_micros BIGINT,
  ADD COLUMN IF NOT EXISTS accounting_currency CHAR(3),
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(20, 10),
  ADD COLUMN IF NOT EXISTS fx_rate_date DATE;

ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_accounting_currency_supported
  CHECK (accounting_currency IS NULL OR accounting_currency IN ('USD', 'EUR'));

-- A converted amount and the currency it is in travel together, exactly as
-- cost_micros and currency do.
ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_accounting_pair
  CHECK ((accounting_cost_micros IS NULL) = (accounting_currency IS NULL));

ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_fx_pair
  CHECK ((fx_rate IS NULL) = (fx_rate_date IS NULL));

-- You cannot have applied a rate without producing a converted amount. The
-- converse is allowed and is the identity case: an event already in the
-- accounting currency has a converted amount and no rate, because no
-- conversion happened and a stored 1.0 would record one that did not.
ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_fx_implies_accounting
  CHECK (fx_rate IS NULL OR accounting_cost_micros IS NOT NULL);

-- And nothing can be converted that was never priced.
ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_accounting_implies_cost
  CHECK (accounting_cost_micros IS NULL OR cost_micros IS NOT NULL);

COMMENT ON COLUMN public.provider_usage_events.accounting_cost_micros IS
  'The cost in micro-units of the accounting currency. NULL when the native '
  'cost could not be converted -- which the meter refuses to silently skip.';
COMMENT ON COLUMN public.provider_usage_events.fx_rate IS
  'The rate applied, or NULL when the event was already in the accounting '
  'currency. Stored per row so history stays reproducible when the rate moves.';

-- ---------------------------------------------------------------------------
-- Recording usage now converts
-- ---------------------------------------------------------------------------

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
  v_row_currency CHAR(3);
  v_currency CHAR(3);
  v_cost BIGINT;
  v_total BIGINT := 0;
  v_any_unpriced BOOLEAN := false;
  v_count INTEGER := 0;
  v_acct CHAR(3);
  v_fx_rate NUMERIC;
  v_fx_date DATE;
  v_acct_cost BIGINT;
  v_age INTEGER;
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
    SELECT r.unit_price, r.currency INTO v_price, v_row_currency
    FROM private.resolve_provider_price_row(p_provider, p_model, v_dim, p_occurred_at) r;

    IF v_price IS NULL THEN
      v_any_unpriced := true;
      v_cost := NULL;
    ELSE
      IF v_currency IS NULL THEN
        v_currency := v_row_currency;
      ELSIF v_currency IS DISTINCT FROM v_row_currency THEN
        RAISE EXCEPTION
          'MIXED_CURRENCY_USAGE_EVENT: % has prices in both % and %',
          p_provider, v_currency, v_row_currency
          USING ERRCODE = 'P3G04';
      END IF;

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
    v_acct := private.accounting_currency();

    SELECT r.rate, r.rate_date INTO v_fx_rate, v_fx_date
    FROM private.resolve_fx_rate(v_currency, v_acct, p_occurred_at) r;

    IF v_fx_rate IS NULL THEN
      -- No rate for this pair at this instant. The cost is still recorded in
      -- its native currency; only the accounting expression is unknown, and
      -- the meter refuses to skip it rather than under-reporting.
      v_acct_cost := NULL;
    ELSE
      v_acct_cost := round(v_total::numeric * v_fx_rate)::bigint;

      -- Warn, do not block (2026-09-03 decision). An old official rate beats
      -- refusing enforcement, and because the rate and its date are stored on
      -- the row, staleness can move a cap decision but never a recorded total.
      v_age := (p_occurred_at AT TIME ZONE 'UTC')::date - v_fx_date;
      IF v_currency <> v_acct AND v_age > private.fx_rate_max_age_days() THEN
        RAISE WARNING
          'STALE_FX_RATE: %->% rate is from % (% days old); conversion applied anyway',
          v_currency, v_acct, v_fx_date, v_age;
      END IF;
    END IF;

    UPDATE public.provider_usage_events
    SET cost_micros = v_total,
        currency = v_currency,
        accounting_cost_micros = v_acct_cost,
        accounting_currency = CASE WHEN v_acct_cost IS NULL THEN NULL ELSE v_acct END,
        -- NULL for the identity case: no conversion happened.
        fx_rate      = CASE WHEN v_acct_cost IS NULL OR v_currency = v_acct THEN NULL ELSE v_fx_rate END,
        fx_rate_date = CASE WHEN v_acct_cost IS NULL OR v_currency = v_acct THEN NULL ELSE v_fx_date END
    WHERE id = v_event_id;
  END IF;

  RETURN v_event_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- The meter now sums converted spend
-- ---------------------------------------------------------------------------

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
      -- ADDED BY 20260903000002; currency-aware in 20260903000005; converting
      -- since 20260903000006.
      --
      -- The window is the SUBSCRIPTION's period, not the draft quota's. Those
      -- are different objects with different owners -- one is billing, one is
      -- an operational cap -- and reading the wrong one would meter spend
      -- against a window the customer is not being billed on.
      --
      -- An organization with no period gets 0, not "everything ever". A spend
      -- meter with no window is a lifetime total, and comparing a lifetime
      -- total against a monthly allowance denies every established customer.
      --
      -- STILL REFUSES RATHER THAN UNDER-REPORTS, but the bar moved. Before
      -- 20260903000006 any foreign-currency spend raised, because none of it
      -- could be converted. Now it raises only for spend that is priced and
      -- still has no accounting expression -- a missing rate for its pair and
      -- date. Everything convertible is converted and counted.
      --
      -- A STALE rate does NOT raise. That is the 2026-09-03 decision and it is
      -- the right one: the rate and its date are stored on every converted
      -- row, so staleness can move an enforcement decision but can never
      -- corrupt a recorded total, and a cap enforced slightly wrong beats a
      -- cap not enforced. `private.fx_rate_status` exposes the age so it can
      -- be alerted on.
      IF EXISTS (
        SELECT 1
        FROM public.provider_usage_events e
        JOIN public.organization_subscriptions s
          ON s.organization_id = e.organization_id
         AND s.status IN ('active', 'past_due')
        WHERE e.organization_id = p_organization_id
          AND s.current_period_start IS NOT NULL
          AND e.occurred_at >= s.current_period_start::timestamptz
          AND e.occurred_at <  s.current_period_end::timestamptz
          AND e.cost_micros IS NOT NULL
          AND e.accounting_cost_micros IS NULL
      ) THEN
        RAISE EXCEPTION
          'UNCONVERTIBLE_SPEND_IN_PERIOD: priced spend exists that cannot be '
          'expressed in % -- no FX rate for its currency on or before its date',
          private.accounting_currency()
          USING ERRCODE = 'P3G05';
      END IF;

      SELECT COALESCE(sum(e.accounting_cost_micros), 0)::int INTO v_used
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
-- Grants: service_role only, like every other private function here
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.resolve_fx_rate(CHAR(3), CHAR(3), TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.resolve_fx_rate(CHAR(3), CHAR(3), TIMESTAMPTZ)
  TO service_role;

REVOKE ALL ON FUNCTION private.fx_rate_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.fx_rate_status() TO service_role;

REVOKE ALL ON FUNCTION private.fx_rate_max_age_days() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.fx_rate_max_age_days() TO service_role;

-- The metric's unit is now knowable again, because conversion exists.
UPDATE public.entitlement_metrics
SET description =
      'Provider spend in the current subscription period, in micro-units of '
      'the accounting currency, converted at the FX rate in force on each '
      'event''s date. Unpriced events are excluded and visible separately; '
      'priced spend with no available rate raises P3G05 rather than being '
      'skipped. A stale rate warns but does not block.'
WHERE key = 'ai_cost_micros';

-- ---------------------------------------------------------------------------
-- The rate
-- ---------------------------------------------------------------------------
--
-- ECB daily euro reference rate, read from the ECB's own feed on 2026-09-03
-- and cross-checked against the ECB's USD reference-rate page. Both gave
-- 1.1578 for reference date 2026-09-02.
--
-- 2026-09-02 rather than 2026-09-03 because the ECB had not published the
-- current day's rate at the time of reading. That is the ordinary state for
-- most of any day and is precisely why rate_date exists.
INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
SELECT 'EUR', 'USD', 1.1578000000, '2026-09-02'::date,
       'ECB reference rate, 2026-09-02 (read from the ECB daily reference feed on 2026-09-03)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fx_rates
  WHERE base_currency = 'EUR' AND quote_currency = 'USD'
    AND rate_date = '2026-09-02'::date
);

-- ---------------------------------------------------------------------------
-- Backfill, and its deliberate limits
-- ---------------------------------------------------------------------------
--
-- Events recorded before this migration have a native cost and no accounting
-- expression. Filling those in is safe and exact for any event whose date has
-- a rate, because it applies the same resolution rule a fresh event would.
--
-- It is self-limiting in the honest direction: an event from before the
-- earliest known rate resolves nothing and stays NULL rather than borrowing a
-- later rate. Reaching backwards with today's rate to value last quarter's
-- spend would be inventing history, which is the one thing the effective-dated
-- design exists to prevent.
-- The LATERAL lives in a CTE because an UPDATE's target table cannot be
-- referenced from its own FROM clause -- `resolve_fx_rate(e.currency, ...)`
-- needs `e` to be an ordinary FROM entry, which it only is in here.
WITH resolved AS (
  SELECT e.id, r.rate, r.rate_date, e.currency, e.cost_micros
  FROM public.provider_usage_events e
  CROSS JOIN LATERAL private.resolve_fx_rate(
    e.currency, private.accounting_currency(), e.occurred_at) r
  WHERE e.cost_micros IS NOT NULL
    AND e.accounting_cost_micros IS NULL
)
UPDATE public.provider_usage_events e
SET accounting_cost_micros = round(x.cost_micros::numeric * x.rate)::bigint,
    accounting_currency = private.accounting_currency(),
    fx_rate      = CASE WHEN x.currency = private.accounting_currency() THEN NULL ELSE x.rate END,
    fx_rate_date = CASE WHEN x.currency = private.accounting_currency() THEN NULL ELSE x.rate_date END
FROM resolved x
WHERE x.id = e.id
  AND x.rate IS NOT NULL;
