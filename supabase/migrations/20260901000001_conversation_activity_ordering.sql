-- Migration: conversation activity ordering
-- Date: 2026-09-01
-- Milestone: Sep 25 — unified inbox
--
-- WHY THIS EXISTS
--
-- An inbox is a list of conversations in the order they were last active. The
-- obvious column to order by is `last_message_at`, and ordering by it is wrong
-- in a way that is easy to miss and unpleasant when it happens.
--
-- `conversations.last_message_at` is NULLABLE. Its only producer is
-- `process_inbound_message`, which sets it from `v_staging.provider_timestamp`
-- at INSERT (20260804000010, lines 67-76). `inbound_message_staging.provider_timestamp`
-- is itself nullable (20260804000004, line 11), and the RPC's validation block
-- checks `contact_identifier` and `provider_message_id` and NOT the timestamp
-- (20260804000010, lines 51-53). So a webhook whose timestamp is missing or
-- unparseable creates a conversation with `last_message_at IS NULL`.
--
-- In PostgreSQL, DESC implies NULLS FIRST. That conversation therefore sorts
-- ABOVE every genuinely recent one, and stays there — the single conversation
-- the system understood least well becomes the permanent top item in every
-- reviewer's inbox. Verified locally on PostgreSQL 16:
--
--   SELECT id FROM demo ORDER BY last_message_at DESC;
--   -- 2 (NULL), 1 (2026-09-01), 3 (2026-08-20)
--
-- Writing `NULLS LAST` at each call site inverts the bug rather than fixing
-- it: the conversation becomes permanently invisible instead of permanently
-- first, which is worse, because nothing on screen is wrong.
--
-- WHAT THIS DOES
--
-- Adds `activity_at`, a generated column equal to `COALESCE(last_message_at,
-- created_at)`. A conversation with no usable message timestamp then sorts by
-- when it arrived, which is the honest answer and needs no special case at any
-- call site. It is generated rather than written by a trigger so it cannot
-- drift from its inputs, and STORED rather than VIRTUAL so it can be indexed.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not backfill, alter, or add NOT NULL to `last_message_at`. That
-- column means "when the last message arrived", and for these rows nothing
-- knows when that was — writing `created_at` into it would replace a truthful
-- NULL with a plausible fabrication, in the column the ingest path reads. The
-- null stays; only the ordering is fixed.
--
-- It also does not fix the missing `provider_timestamp` validation upstream.
-- That is a change to the ingest path with its own blast radius, and this
-- migration has to be correct whether or not that is ever tightened — a NULL
-- arriving from any future source is handled by the same COALESCE.

-- Generated, so it cannot disagree with its inputs; STORED, so it can be indexed.
-- NOT NULL is safe and worth asserting: `created_at` is NOT NULL, so the
-- COALESCE has no path to null. Stating it makes any future change that would
-- break that assumption fail here rather than in an inbox query.
ALTER TABLE public.conversations
  ADD COLUMN activity_at TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(last_message_at, created_at)) STORED NOT NULL;

COMMENT ON COLUMN public.conversations.activity_at IS
  'When this conversation was last active, for ordering. COALESCE(last_message_at, created_at): '
  'last_message_at is nullable and DESC implies NULLS FIRST, so ordering on it directly puts a '
  'conversation with an unparseable webhook timestamp above every recent one. Generated and '
  'STORED; never write to it.';

-- Ordering index for the unfiltered inbox. Matches the query's ORDER BY
-- exactly, including the `id` tiebreak, so keyset pagination reads it as a
-- range scan rather than sorting the organization's conversations per page.
--
-- The `id` tiebreak is not decoration: two conversations can share an
-- `activity_at` (one webhook batch, one `provider_timestamp`), and without a
-- total order the page boundary is unstable — the same conversation can appear
-- on two consecutive pages, or on neither.
CREATE INDEX IF NOT EXISTS idx_conversations_org_activity
  ON public.conversations (organization_id, activity_at DESC, id DESC);

-- The same, for a status-filtered inbox. A separate index rather than relying
-- on the one above with a filter: `status` leads here, so "open, most recent
-- first" is a range scan, whereas the index above would have to scan every
-- conversation in the organization and discard.
CREATE INDEX IF NOT EXISTS idx_conversations_org_status_activity
  ON public.conversations (organization_id, status, activity_at DESC, id DESC);
