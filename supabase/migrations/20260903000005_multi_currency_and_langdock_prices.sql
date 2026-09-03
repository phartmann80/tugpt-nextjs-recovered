-- ===========================================================================
-- Multi-currency, and the Langdock price book
--
-- Migration: 20260903000005_multi_currency_and_langdock_prices.sql
--
-- 20260903000002 constrained every currency column to 'USD' and said why:
--
--     "Summing mixed currencies is a silent, plausible, wrong number -- the
--      worst kind. One currency with a constraint means the day a EUR-billing
--      provider arrives, the constraint fails loudly and someone makes a
--      decision, instead of the totals quietly becoming meaningless."
--
-- This is that day. Paul confirmed Langdock's per-model rates on 2026-09-03
-- and confirmed the billing currency is EUR. Gladia bills USD. So the price
-- book now holds two currencies, and this migration is the decision that
-- check was written to force.
--
-- ---------------------------------------------------------------------------
-- 1. THE BUG THIS WOULD HAVE SHIPPED
-- ---------------------------------------------------------------------------
--
-- `record_provider_usage` never set `currency`. It listed the event's columns
-- explicitly and left that one out, so every row took the column default,
-- which was 'USD'.
--
-- With a USD-only price book that was invisible and harmless. Seed EUR rates
-- without fixing it and every Langdock event is stamped USD while its
-- components carry EUR unit prices -- a row that is internally inconsistent,
-- passes every existing constraint, and sums into a total that is wrong by
-- whatever the exchange rate happens to be.
--
-- So: the event's currency is now DERIVED from the prices actually resolved,
-- never defaulted. There is no default any more, because a default is what
-- caused this.
--
-- ---------------------------------------------------------------------------
-- 2. CURRENCY IS NULL EXACTLY WHEN COST IS
-- ---------------------------------------------------------------------------
--
-- `cost_micros` is nullable because an unpriced call is a real record with an
-- unknown cost. The currency of an unknown cost is equally unknown, and
-- stamping 'USD' on it is a guess that later reads as fact.
--
-- Enforced as a biconditional rather than left to convention: a row with a
-- cost and no currency is an unlabelled number, and a row with a currency and
-- no cost is a label with nothing under it. Neither should be storable.
--
-- ---------------------------------------------------------------------------
-- 3. ONE EVENT, ONE CURRENCY
-- ---------------------------------------------------------------------------
--
-- An event's components are summed into its total, so they must share a
-- currency for that sum to mean anything. Two components resolving prices in
-- different currencies is a price-book error -- someone seeded input_tokens in
-- EUR and output_tokens in USD for the same model -- and it is refused with
-- P3G04 rather than silently added together.
--
-- ---------------------------------------------------------------------------
-- 4. THE METER REFUSES TO UNDER-REPORT (P3G05)
-- ---------------------------------------------------------------------------
--
-- `ai_cost_micros` sums spend for an entitlement check. With two currencies in
-- play there are three options and only one of them is honest:
--
--   * Sum across currencies. Adds euros to dollars. Never.
--   * Sum only the accounting currency and skip the rest. Silently under-
--     reports, which for an enforcement meter means letting an organization
--     exceed a cap it has already passed. This is the worst option precisely
--     because it looks like it works.
--   * Refuse. The meter raises P3G05 when the window contains priced spend it
--     cannot express in the accounting currency.
--
-- It refuses. You cannot enforce a spend cap you cannot compute, and the
-- failure should happen at the check rather than in the invoice.
--
-- BLAST RADIUS, STATED PLAINLY: once an `ai_cost_micros` ALLOWANCE exists in a
-- plan, an organization with EUR spend will fail that check until an FX rate
-- exists. No plan rows are seeded today and nothing calls this function for
-- enforcement yet, so nothing breaks now -- but seeding a cost allowance
-- requires the conversion story first, and that ordering is deliberate.
--
-- NOT BUILT HERE: the FX table. It needs one number nobody has given me -- the
-- EUR->USD rate to account at, and its source. Inventing one would be exactly
-- the "wrong price is worse than a missing price" failure this file is about,
-- one level up. The mechanism is a separate change, unblocked by a single
-- input.
--
-- ---------------------------------------------------------------------------
-- 5. THE RATES
-- ---------------------------------------------------------------------------
--
-- Langdock workspace pricing, read by Paul on 2026-09-03, EUR per 1M tokens:
--
--     gpt-5-mini   in 0.21   out  1.71
--     gpt-5.1      in 1.07   out  8.57
--     gpt-5.2      in 1.50   out 12.00
--     gpt-5        in 1.07   out  8.57
--
-- gpt-5.1 and gpt-5 are IDENTICAL. That is what the source says; it is not a
-- transcription error, and it is recorded here so that a future reader who
-- notices the duplication does not "fix" it.
--
-- Stored per token: 0.21 / 1e6 = 0.0000002100. Every one of the eight values
-- is exact at NUMERIC(20,10) -- none of them repeats -- so unlike the Gladia
-- per-second rate there is no truncated tail to account for.
--
-- The four models are exactly LANGDOCK_ALLOWED_MODELS. A model on that
-- allowlist with no price here would bill as priced-unknown forever, so
-- `packages/ai-providers/src/langdock-prices.test.ts` reads this file and
-- fails if the two lists ever diverge.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The accounting currency
-- ---------------------------------------------------------------------------

-- A function rather than a literal repeated in three places. The value is a
-- platform decision, and the day it changes it should change once.
CREATE OR REPLACE FUNCTION private.accounting_currency()
RETURNS CHAR(3)
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 'USD'::char(3) $$;

COMMENT ON FUNCTION private.accounting_currency IS
  'The currency provider spend is metered in. Native costs are stored as '
  'billed; conversion to this currency is a separate, unbuilt mechanism.';

-- ---------------------------------------------------------------------------
-- Widen the currency domain
-- ---------------------------------------------------------------------------

-- Still a CHECK and not a lookup table. The set is small, code-coupled, and a
-- typo mis-categorises loudly at the write rather than granting anything.
ALTER TABLE public.provider_prices
  DROP CONSTRAINT IF EXISTS provider_prices_currency_check;
ALTER TABLE public.provider_prices
  ADD CONSTRAINT provider_prices_currency_supported
  CHECK (currency IN ('USD', 'EUR'));

ALTER TABLE public.provider_usage_events
  DROP CONSTRAINT IF EXISTS provider_usage_events_currency_check;

-- No default, and nullable: see sections 1 and 2 above.
ALTER TABLE public.provider_usage_events
  ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE public.provider_usage_events
  ALTER COLUMN currency DROP NOT NULL;

ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_currency_supported
  CHECK (currency IS NULL OR currency IN ('USD', 'EUR'));

ALTER TABLE public.provider_usage_events
  ADD CONSTRAINT provider_usage_events_cost_currency_together
  CHECK ((cost_micros IS NULL) = (currency IS NULL));

COMMENT ON COLUMN public.provider_usage_events.currency IS
  'The currency this event was billed in, derived from the prices resolved '
  'for it. NULL exactly when cost_micros is NULL: the currency of an unknown '
  'cost is also unknown.';

-- ---------------------------------------------------------------------------
-- Price resolution now returns the currency too
-- ---------------------------------------------------------------------------

-- The resolution RULE -- exact model beats provider-wide, most recent
-- effective window wins -- now lives in exactly one place. The scalar
-- `resolve_provider_price` below becomes a wrapper over this rather than a
-- second copy of the same ORDER BY, because two copies of a resolution rule
-- drift and only one of them gets fixed.
CREATE OR REPLACE FUNCTION private.resolve_provider_price_row(
  p_provider TEXT,
  p_model TEXT,
  p_dimension TEXT,
  p_at TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS TABLE (unit_price NUMERIC, currency CHAR(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT p.unit_price, p.currency
  FROM public.provider_prices p
  WHERE p.provider = p_provider
    AND p.dimension = p_dimension
    AND (p.model = p_model OR p.model IS NULL)
    AND p.effective_from <= p_at
    AND (p.effective_to IS NULL OR p.effective_to > p_at)
  ORDER BY (p.model IS NOT NULL) DESC
  LIMIT 1;
$$;

-- Signature unchanged on purpose: every existing caller and assertion keeps
-- working, and the currency is additive rather than a breaking change.
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
  SELECT r.unit_price
  FROM private.resolve_provider_price_row(p_provider, p_model, p_dimension, p_at) r;
$$;

-- ---------------------------------------------------------------------------
-- Recording usage: the currency is derived, and disagreement is refused
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
BEGIN
  IF p_quantities IS NULL OR jsonb_typeof(p_quantities) <> 'object'
     OR p_quantities = '{}'::jsonb THEN
    RAISE EXCEPTION 'EMPTY_USAGE_QUANTITIES'
      USING ERRCODE = 'P3G03';
  END IF;

  -- currency is deliberately absent here. It is set below, from the prices
  -- that actually resolved, or left NULL alongside a NULL cost.
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
      -- An event's components are summed into one total, so they have to
      -- share a currency for that total to mean anything. Disagreement is a
      -- price-book error, not something to add together.
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
    UPDATE public.provider_usage_events
    SET cost_micros = v_total,
        currency = v_currency
    WHERE id = v_event_id;
  END IF;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION private.record_provider_usage IS
  'Records one provider call and its billed components, pricing them from '
  'provider_prices at the time of the call. A missing price yields a recorded '
  'but unpriced row rather than an error or a zero. The event currency is '
  'derived from the prices used and never defaulted; components disagreeing '
  'on currency raise P3G04.';

-- ---------------------------------------------------------------------------
-- The cost meter, made currency-aware
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
      -- ADDED BY 20260903000002; made currency-aware by 20260903000005.
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
      -- REFUSES RATHER THAN UNDER-REPORTS. Langdock bills EUR and Gladia bills
      -- USD, so a period can contain spend this meter cannot express in the
      -- accounting currency. Summing across currencies adds euros to dollars;
      -- skipping the foreign rows returns a number that is too small, which
      -- for an enforcement meter means letting an organization past a cap it
      -- has already exceeded -- and it looks like it works, which is why it is
      -- the worse of the two. So it raises, and the message names the missing
      -- input rather than the symptom.
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
          AND e.currency IS DISTINCT FROM private.accounting_currency()
      ) THEN
        RAISE EXCEPTION
          'UNCONVERTIBLE_SPEND_IN_PERIOD: spend recorded in a currency other '
          'than % and no conversion is configured',
          private.accounting_currency()
          USING ERRCODE = 'P3G05';
      END IF;

      SELECT COALESCE(sum(e.cost_micros), 0)::int INTO v_used
      FROM public.provider_usage_events e
      JOIN public.organization_subscriptions s
        ON s.organization_id = e.organization_id
       AND s.status IN ('active', 'past_due')
      WHERE e.organization_id = p_organization_id
        AND s.current_period_start IS NOT NULL
        AND e.occurred_at >= s.current_period_start::timestamptz
        AND e.occurred_at <  s.current_period_end::timestamptz
        AND e.currency = private.accounting_currency();

    ELSE
      RAISE EXCEPTION 'UNCOUNTABLE_ENTITLEMENT_METRIC: %', p_metric
        USING ERRCODE = 'P3F02';
  END CASE;

  RETURN COALESCE(v_used, 0);
END;
$$;

-- The new resolver is service-role only, exactly like the scalar it backs.
REVOKE ALL ON FUNCTION private.resolve_provider_price_row(TEXT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.resolve_provider_price_row(TEXT, TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;

REVOKE ALL ON FUNCTION private.accounting_currency() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.accounting_currency() TO service_role;

-- The metric's unit was written as micro-USD when USD was the only currency.
-- It is the accounting currency that is meant, and the two are only the same
-- thing by coincidence of the current value.
UPDATE public.entitlement_metrics
SET unit = 'µ(accounting currency)',
    description =
      'Provider spend in the current subscription period, in micro-units of '
      'the accounting currency. Summed from provider_usage_events; unpriced '
      'events are excluded and visible separately, and spend in another '
      'currency raises P3G05 rather than being skipped.'
WHERE key = 'ai_cost_micros';

-- ---------------------------------------------------------------------------
-- The Langdock price book
-- ---------------------------------------------------------------------------
--
-- Idempotent on the natural key for the same reason as the Gladia seed: the
-- table's guard is a GiST exclusion against overlapping ranges, which raises
-- rather than skips, so a re-run has to be prevented by asking whether the row
-- is already there.
--
-- Model-specific rows (not NULL): these rates differ per model, so a
-- provider-wide row would quietly charge gpt-5-mini at gpt-5.2 rates for any
-- model that lost its own entry.
INSERT INTO public.provider_prices (
  provider, model, dimension, unit_price, currency, effective_from, source
)
SELECT
  'langdock', v.model, v.dimension, v.unit_price, 'EUR',
  '2026-09-03T00:00:00Z'::timestamptz, v.source
FROM (VALUES
  ('gpt-5-mini', 'input_tokens',  0.0000002100::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5-mini input EUR 0.21 per 1M tokens.'),
  ('gpt-5-mini', 'output_tokens', 0.0000017100::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5-mini output EUR 1.71 per 1M tokens.'),
  ('gpt-5.1',    'input_tokens',  0.0000010700::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5.1 input EUR 1.07 per 1M tokens.'),
  ('gpt-5.1',    'output_tokens', 0.0000085700::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5.1 output EUR 8.57 per 1M tokens.'),
  ('gpt-5.2',    'input_tokens',  0.0000015000::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5.2 input EUR 1.50 per 1M tokens.'),
  ('gpt-5.2',    'output_tokens', 0.0000120000::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5.2 output EUR 12.00 per 1M tokens.'),
  -- gpt-5 matches gpt-5.1 exactly. Per the source, not a copy-paste slip.
  ('gpt-5',      'input_tokens',  0.0000010700::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5 input EUR 1.07 per 1M tokens (same as gpt-5.1 per source).'),
  ('gpt-5',      'output_tokens', 0.0000085700::numeric,
   'Langdock workspace pricing read by Paul 2026-09-03: gpt-5 output EUR 8.57 per 1M tokens (same as gpt-5.1 per source).')
) AS v(model, dimension, unit_price, source)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_prices p
  WHERE p.provider = 'langdock'
    AND p.model = v.model
    AND p.dimension = v.dimension
    AND p.effective_to IS NULL
);

-- ---------------------------------------------------------------------------
-- Historical events are left alone
-- ---------------------------------------------------------------------------
-- Events recorded before these rates existed carry cost_micros NULL, and they
-- stay that way. Backfilling would mean asserting that a price confirmed today
-- was in force then, which nobody has said and which the effective-dated
-- design exists precisely to avoid claiming. An unpriced historical row is
-- visibly unpriced; a backfilled one is invisibly assumed.
