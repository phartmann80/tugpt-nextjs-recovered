-- pgTAP tests: what the 2026-08-19 migrations changed
-- File: supabase/tests/database/draft_attribution_and_audit.test.sql
--
-- Covers 20260819000001, 20260819000002 and 20260819000003. Before this file
-- none of the three had a single assertion, which is exactly how the older
-- assertions drifted behind them unnoticed: the suite was not running, and the
-- new behaviour was not asserted, so there was nothing to notice.
--
--   20260819000001  failed_jobs.provider_error_detail, its 512-char backstop,
--                   and the extended dead-letter error-code allowlist.
--   20260819000002  applied_migration_versions(), which the milestone harness
--                   preflight uses to prove the deployed schema matches the
--                   checkout. If it silently returns nothing, that gate passes
--                   vacuously.
--   20260819000003  provider/model recorded on the completed job row, and
--                   ai_draft_review_events made append-only with a nullable
--                   actor_id so erasing a reviewer's profile is possible.

BEGIN;
SELECT plan(22);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO public.organizations (id, name, slug)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'attribution-audit-org');

INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');

INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-attr-001', 'active');

INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 10);

-- The reviewer whose profile gets erased in section 4. Inserting into
-- auth.users lets the handle_new_user trigger create the profile, the same way
-- a real signup does.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change
) VALUES (
  '00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444',
  'authenticated', 'authenticated', 'reviewer@example.com', '', '2026-01-01 00:00:00',
  '2026-01-01 00:00:00', '2026-01-01 00:00:00', '{}', '{}', false, '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role)
VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'admin')
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- Five inbound messages, one per draft generation job used below.
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-attr-001', 'meta', 'wamid.attr001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.attr001', '15559876543', 'text', 'Hello 1',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-attr001'
);
SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr001'));

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-attr-001', 'meta', 'wamid.attr002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.attr002', '15559876543', 'text', 'Hello 2',
  '2026-01-01T00:00:01Z'::timestamptz, 'req-attr002'
);
SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr002'));

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-attr-001', 'meta', 'wamid.attr003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.attr003', '15559876543', 'text', 'Hello 3',
  '2026-01-01T00:00:02Z'::timestamptz, 'req-attr003'
);
SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr003'));

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-attr-001', 'meta', 'wamid.attr004', 'message',
  '0000000000000000000000000000000000000000000000000000000000000004',
  'wamid.attr004', '15559876543', 'text', 'Hello 4',
  '2026-01-01T00:00:03Z'::timestamptz, 'req-attr004'
);
SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr004'));

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-attr-001', 'meta', 'wamid.attr005', 'message',
  '0000000000000000000000000000000000000000000000000000000000000005',
  'wamid.attr005', '15559876543', 'text', 'Hello 5',
  '2026-01-01T00:00:04Z'::timestamptz, 'req-attr005'
);
SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr005'));

CREATE TEMP TABLE _attr_ids AS
SELECT
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr001')) AS msg1,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr002')) AS msg2,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr003')) AS msg3,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr004')) AS msg4,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.attr005')) AS msg5,
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111') AS conv_id;

-- Helper: create a queued job for one source message, enqueue it, and claim it
-- through the production read RPC so it carries a pgmq_msg_id and attempts >= 1.
-- Archiving requires both (P3B16 otherwise), so this mirrors the worker exactly.
CREATE OR REPLACE FUNCTION pg_temp.claim_job(p_msg UUID)
RETURNS TABLE(job_id UUID, msg_id BIGINT)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_job UUID;
  v_msg BIGINT;
BEGIN
  INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
  SELECT pg_catalog.gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, p_msg,
         '22222222-2222-2222-2222-222222222222', 'queued'
  FROM _attr_ids
  RETURNING id INTO v_job;

  PERFORM pgmq.send('draft_generation', pg_catalog.jsonb_build_object(
    'draftGenerationJobId', v_job,
    'requestId', 'draft-' || p_msg::text,
    'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ), 0);

  SELECT r.msg_id INTO v_msg FROM public.read_draft_generation_jobs(30, 1) r LIMIT 1;

  RETURN QUERY SELECT v_job, v_msg;
END;
$fn$;

-- =============================================================================
-- 1. failed_jobs.provider_error_detail exists and is bounded (20260819000001)
-- =============================================================================

SELECT has_column(
  'public', 'failed_jobs', 'provider_error_detail',
  'A1: failed_jobs has provider_error_detail'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'failed_jobs_provider_error_detail_length' AND contype = 'c'
  ),
  'A2: the 512-character backstop CHECK on provider_error_detail exists'
);

-- =============================================================================
-- 2. Archiving records the provider's own words (20260819000001)
-- =============================================================================

-- DRAFT_PROVIDER_CONFIG_ERROR is one of the codes 20260819000001 added to the
-- allowlist. The worker was already producing it and every archive using it was
-- being rejected, so this doubles as the regression test for that fix.
CREATE TEMP TABLE _archive_a AS SELECT * FROM pg_temp.claim_job((SELECT msg1 FROM _attr_ids));

CREATE TEMP TABLE _archive_a_result AS
SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _archive_a),
  (SELECT job_id FROM _archive_a),
  'DRAFT_PROVIDER_CONFIG_ERROR',
  'langdock returned 401: invalid api key'
);

SELECT is(
  (SELECT archived FROM _archive_a_result),
  true,
  'A3: DRAFT_PROVIDER_CONFIG_ERROR is an accepted dead-letter code'
);

SELECT is(
  (SELECT provider_error_detail FROM public.failed_jobs
   WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _archive_a)),
  'langdock returned 401: invalid api key',
  'A4: the provider detail is stored verbatim'
);

-- The application sanitizes and caps at 300 characters; the database truncates
-- at 512 so the CHECK cannot be violated if that cap ever drifts.
CREATE TEMP TABLE _archive_b AS SELECT * FROM pg_temp.claim_job((SELECT msg2 FROM _attr_ids));

SELECT lives_ok(
  $$
    SELECT * FROM private.archive_draft_failed_job(
      (SELECT msg_id FROM _archive_b),
      (SELECT job_id FROM _archive_b),
      'DRAFT_PROVIDER_ERROR',
      repeat('x', 600)
    )
  $$,
  'A5: an over-long provider detail does not violate the CHECK'
);

SELECT is(
  (SELECT char_length(provider_error_detail) FROM public.failed_jobs
   WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _archive_b)),
  512,
  'A6: it is truncated to 512 characters rather than rejected'
);

-- Whitespace is not a detail.
CREATE TEMP TABLE _archive_c AS SELECT * FROM pg_temp.claim_job((SELECT msg3 FROM _attr_ids));

SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _archive_c),
  (SELECT job_id FROM _archive_c),
  'DRAFT_EXHAUSTED_RETRIES',
  '     '
);

-- Written as ok(... IS NULL) rather than is(..., NULL): pgTAP's is() is
-- polymorphic, and an untyped NULL literal makes the call ambiguous.
SELECT ok(
  (SELECT provider_error_detail FROM public.failed_jobs
   WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _archive_c)) IS NULL,
  'A7: a whitespace-only detail is stored as NULL, not as blanks'
);

-- The allowlist is still an allowlist.
CREATE TEMP TABLE _archive_d AS SELECT * FROM pg_temp.claim_job((SELECT msg4 FROM _attr_ids));

SELECT throws_ok(
  $$
    SELECT * FROM private.archive_draft_failed_job(
      (SELECT msg_id FROM _archive_d),
      (SELECT job_id FROM _archive_d),
      'DRAFT_SOMETHING_INVENTED',
      NULL
    )
  $$,
  'P3B15',
  'INVALID_DRAFT_FAILURE_CODE',
  'A8: an unrecognised dead-letter code still raises P3B15'
);

-- =============================================================================
-- 3. The completed job row records which model produced the draft (20260819000003)
-- =============================================================================

CREATE TEMP TABLE _attr_job AS
SELECT pg_catalog.gen_random_uuid() AS id;

INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT (SELECT id FROM _attr_job), '11111111-1111-1111-1111-111111111111', conv_id, msg5,
       '22222222-2222-2222-2222-222222222222', 'queued'
FROM _attr_ids;

SELECT * FROM private.reserve_draft_usage((SELECT id FROM _attr_job));

CREATE TEMP TABLE _attr_draft AS
SELECT private.store_draft(
  (SELECT id FROM _attr_job),
  '22222222-2222-2222-2222-222222222222',
  (SELECT conv_id FROM _attr_ids),
  (SELECT msg5 FROM _attr_ids),
  'Generated draft body',
  'langdock',
  'gpt-5-mini'
) AS draft_id;

SELECT is(
  (SELECT provider FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _attr_job)),
  'langdock',
  'A9: the completed job row records the provider'
);

SELECT is(
  (SELECT model FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _attr_job)),
  'gpt-5-mini',
  'A10: the completed job row records the model'
);

-- Job and draft must agree. Before 20260819000003 the draft carried the model
-- and the job carried NULL, so per-model attribution had to be reconstructed by
-- joining back through the draft.
SELECT is(
  (SELECT j.provider || '/' || j.model
   FROM public.draft_generation_jobs j WHERE j.id = (SELECT id FROM _attr_job)),
  (SELECT d.provider || '/' || d.model
   FROM public.ai_drafts d WHERE d.id = (SELECT draft_id FROM _attr_draft)),
  'A11: job attribution and draft attribution agree'
);

-- =============================================================================
-- 4. ai_draft_review_events is append-only and survives reviewer erasure
--    (20260819000003)
-- =============================================================================

SELECT col_is_null(
  'public', 'ai_draft_review_events', 'actor_id',
  'A12: actor_id is nullable'
);

SELECT ok(
  NOT (
    has_table_privilege('service_role', 'public.ai_draft_review_events', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.ai_draft_review_events', 'UPDATE')
    OR has_table_privilege('anon', 'public.ai_draft_review_events', 'UPDATE')
  ),
  'A13: no role holds UPDATE on ai_draft_review_events'
);

SELECT ok(
  NOT (
    has_table_privilege('service_role', 'public.ai_draft_review_events', 'DELETE')
    OR has_table_privilege('authenticated', 'public.ai_draft_review_events', 'DELETE')
    OR has_table_privilege('anon', 'public.ai_draft_review_events', 'DELETE')
  ),
  'A14: no role holds DELETE on ai_draft_review_events'
);

INSERT INTO public.ai_draft_review_events (organization_id, draft_id, action, actor_id, previous_version, new_version)
SELECT '11111111-1111-1111-1111-111111111111', (SELECT draft_id FROM _attr_draft),
       'approve', '44444444-4444-4444-4444-444444444444', 1, 1;

-- The compliance case. Before 20260819000003 actor_id was NOT NULL while the FK
-- said ON DELETE SET NULL, so this DELETE failed with a not-null violation and
-- erasing a reviewer was impossible for as long as their review events existed.
SELECT lives_ok(
  $$DELETE FROM public.profiles WHERE id = '44444444-4444-4444-4444-444444444444'$$,
  'A15: a profile that has reviewed a draft can be deleted'
);

SELECT is(
  (SELECT (count(*) FILTER (WHERE actor_id IS NULL))::int
   FROM public.ai_draft_review_events
   WHERE draft_id = (SELECT draft_id FROM _attr_draft)),
  1,
  'A16: the review event survives the erasure with actor_id set to NULL'
);

-- =============================================================================
-- 5. applied_migration_versions (20260819000002)
-- =============================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'applied_migration_versions' AND p.pronargs = 0
  ),
  'A17: private.applied_migration_versions() exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'applied_migration_versions' AND p.pronargs = 0
  ),
  'A18: public.applied_migration_versions() exists'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.applied_migration_versions()', 'EXECUTE'),
  'A19: anon cannot read the applied migration list'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.applied_migration_versions()', 'EXECUTE'),
  'A20: authenticated cannot read the applied migration list'
);

SELECT ok(
  has_function_privilege('service_role', 'public.applied_migration_versions()', 'EXECUTE'),
  'A21: service_role can read the applied migration list'
);

-- Asserted against supabase_migrations.schema_migrations rather than a
-- hard-coded version, so this does not need editing with every migration. If
-- the function ever silently returns nothing — its guard clause returns early
-- when the table is missing — the harness preflight would pass vacuously, and
-- this is what catches that.
SELECT is(
  (SELECT count(*)::int || ':' || COALESCE(max(version), 'none') FROM public.applied_migration_versions()),
  (SELECT count(*)::int || ':' || COALESCE(max(version)::text, 'none') FROM supabase_migrations.schema_migrations),
  'A22: it reports exactly the applied migrations, newest matching'
);

SELECT * FROM finish();
ROLLBACK;
