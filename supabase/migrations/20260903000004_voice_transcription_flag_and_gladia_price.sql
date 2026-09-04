-- ===========================================================================
-- Voice transcription: the flag that keeps it off, and the price that makes
-- its cost real.
--
-- Migration: 20260903000004_voice_transcription_flag_and_gladia_price.sql
--
-- Two seeds and no new tables. The Gladia adapter
-- (packages/ai-providers/src/gladia.ts) is inert without both of them, and
-- neither belongs in application configuration.
--
-- ---------------------------------------------------------------------------
-- 1. WHY A FLAG ROW AND NOT A CONSTANT
-- ---------------------------------------------------------------------------
--
-- ADR-015 D1: a capability that can spend money is gated by a real
-- `feature_flags` row read through `is_feature_enabled`, never by a
-- `KILL_SWITCHES` constant in the code. The difference is who can turn it off
-- and how fast. A constant needs a deploy; a row needs an UPDATE, and the
-- moment that matters is the one where an ingest loop is transcribing the same
-- voice note repeatedly at $0.61 an hour and nobody wants to wait for CI.
--
-- Seeded globally false, exactly as `ai_draft_generation` was in
-- 20260805000011. Per-organization enablement is an ordinary row and needs no
-- schema change.
--
-- ---------------------------------------------------------------------------
-- 2. WHY THE PRICE IS A ROW AND NOT AN ENVIRONMENT VARIABLE
-- ---------------------------------------------------------------------------
--
-- `provider_usage_components` copies the rate onto every row at write time, so
-- history is immutable — but the *current* rate has to come from somewhere a
-- person can read, diff and review. A number in an env var is a number nobody
-- reviewed, that changes without a commit, and that cannot be asked "what was
-- this on the 3rd?".
--
-- The `source` column exists for the same reason: a price with no provenance
-- is a price nobody can re-verify when the vendor changes their pricing page.
--
-- ---------------------------------------------------------------------------
-- 3. THE ARITHMETIC, WRITTEN OUT
-- ---------------------------------------------------------------------------
--
-- Gladia Starter / pay-as-you-go, asynchronous transcription: USD 0.61 per
-- hour of billed audio.
--
--     0.61 / 3600 = 0.000169444444...  USD per second
--
-- stored at NUMERIC(20,10) as 0.0001694444. The truncated tail costs
-- 1.6e-7 USD per hour — under a fifth of one micro-dollar — and
-- `record_provider_usage` rounds once, at the recorded cost, so the error
-- cannot accumulate across components.
--
-- `model` is NULL, meaning "any model from this provider". Gladia's
-- pre-recorded endpoint names no model, and `resolve_provider_price` already
-- prefers a model-specific row over a NULL one, so a future per-model rate
-- slots in without touching this row.
--
-- NOT SEEDED: Gladia's real-time rate (USD 0.75/hr) and the Growth volume
-- rate (from USD 0.20/hr). Neither is in use. A price for a product nobody
-- calls is a row that will be stale before it is ever read, and a wrong price
-- is worse than a missing one — a missing price records the call unpriced and
-- visibly so, while a wrong one records a plausible number.
--
-- ---------------------------------------------------------------------------
-- 4. ON THE 10 FREE HOURS PER MONTH
-- ---------------------------------------------------------------------------
--
-- Deliberately not modelled. A free-tier credit is a property of the billing
-- account, not of a call. Every event records its gross cost and credits are
-- reconciled against the invoice. Building "the first 10 hours are free" into
-- per-call cost would produce rows that disagree with the invoice the moment
-- the allowance runs out mid-month, and would under-report an organization's
-- real consumption to the entitlement meter for the whole first stretch of
-- every month.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------

INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES (NULL, 'voice_transcription', false, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- The price
-- ---------------------------------------------------------------------------

-- Idempotent on the natural key rather than ON CONFLICT DO NOTHING: there is
-- no unique constraint to conflict on (the table's guard is a GiST exclusion
-- against overlapping effective ranges, which would raise rather than skip),
-- so a re-run has to be prevented by asking whether the row is already there.
INSERT INTO public.provider_prices (
  provider, model, dimension, unit_price, currency, effective_from, source
)
SELECT
  'gladia',
  NULL,
  'audio_seconds',
  0.0001694444,
  'USD',
  '2026-09-03T00:00:00Z'::timestamptz,
  'Gladia pricing, Starter pay-as-you-go async: USD 0.61 per hour of billed audio (= 0.61/3600 per second). Approved 2026-09-03.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_prices
  WHERE provider = 'gladia'
    AND model IS NULL
    AND dimension = 'audio_seconds'
    AND effective_to IS NULL
);

-- ---------------------------------------------------------------------------
-- Nothing is granted here.
-- ---------------------------------------------------------------------------
-- `provider_prices` carries the privileges 20260903000002 gave it, and this
-- migration adds a row rather than a capability.
