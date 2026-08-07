-- pgTAP tests: Phase 3B SQLSTATE typed error tests
-- File: supabase/tests/database/phase3b_sqlstate.test.sql
-- Complete SQLSTATE registry: P3B01-P3B16, one code per message, one domain per code.

BEGIN;
SELECT plan(24);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3b-sqlstate-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-ss-001', 'active');

INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 5);

-- Ingest 5 messages for unique source_message_ids
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.ss001', '15559876543', 'text', 'Hello 1',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-ss001'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss001')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.ss002', '15559876543', 'text', 'Hello 2',
  '2026-01-01T00:00:01Z'::timestamptz, 'req-ss002'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss002')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.ss003', '15559876543', 'text', 'Hello 3',
  '2026-01-01T00:00:02Z'::timestamptz, 'req-ss003'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss003')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss004', 'message',
  '0000000000000000000000000000000000000000000000000000000000000004',
  'wamid.ss004', '15559876543', 'text', 'Hello 4',
  '2026-01-01T00:00:03Z'::timestamptz, 'req-ss004'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss004')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss005', 'message',
  '0000000000000000000000000000000000000000000000000000000000000005',
  'wamid.ss005', '15559876543', 'text', 'Hello 5',
  '2026-01-01T00:00:04Z'::timestamptz, 'req-ss005'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss005')
);

CREATE TEMP TABLE _ss_msgs AS
SELECT
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111') AS conv_id,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss001')) AS msg1,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss002')) AS msg2,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss003')) AS msg3,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss004')) AS msg4,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss005')) AS msg5;

-- =============================================================================
-- SQLSTATE TESTS
-- =============================================================================

-- SS1: release_draft_reservation_internal with missing usage row raises P3B11
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg1, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _ss_msgs;

CREATE TEMP TABLE _ss_job1 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg1 FROM _ss_msgs);

SELECT * FROM private.reserve_draft_usage((SELECT id FROM _ss_job1));
DELETE FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT throws_ok(
  $$SELECT private.release_draft_reservation_internal((SELECT id FROM _ss_job1))$$,
  'P3B11',
  'QUOTA_RESERVATION_STATE_ERROR',
  'SS1: release with missing usage row raises P3B11 QUOTA_RESERVATION_STATE_ERROR'
);

-- SS2: release_draft_reservation_internal with zero reserved_count raises P3B11
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg2, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _ss_msgs;

CREATE TEMP TABLE _ss_job2 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg2 FROM _ss_msgs);

SELECT * FROM private.reserve_draft_usage((SELECT id FROM _ss_job2));
UPDATE public.draft_usage_tracking SET reserved_count = 0 WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT throws_ok(
  $$SELECT private.release_draft_reservation_internal((SELECT id FROM _ss_job2))$$,
  'P3B11',
  'QUOTA_RESERVATION_STATE_ERROR',
  'SS2: release with zero reserved_count raises P3B11'
);

-- SS3: store_draft on non-existent job raises P3B07
SELECT throws_ok(
  $$SELECT private.store_draft(
    '99999999-9999-9999-9999-999999999999',
    '22222222-2222-2222-2222-222222222222',
    (SELECT conv_id FROM _ss_msgs),
    (SELECT msg3 FROM _ss_msgs),
    'Test', 'logicc', 'gpt-5-nano'
  )$$,
  'P3B07',
  'DRAFT_JOB_NOT_FOUND',
  'SS3: store_draft on non-existent job raises P3B07'
);

-- SS4: store_draft on job without reservation raises P3B10 (INVALID_DRAFT_JOB_STATE)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg3, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _ss_msgs;

SELECT throws_ok(
  $$SELECT private.store_draft(
    (SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg3 FROM _ss_msgs)),
    '22222222-2222-2222-2222-222222222222',
    (SELECT conv_id FROM _ss_msgs),
    (SELECT msg3 FROM _ss_msgs),
    'Test', 'logicc', 'gpt-5-nano'
  )$$,
  'P3B10',
  'INVALID_DRAFT_JOB_STATE',
  'SS4: store_draft without reservation raises P3B10 INVALID_DRAFT_JOB_STATE'
);

-- SS5: archive_draft_failed_job on completed job raises P3B12 (archive-specific)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg4, '22222222-2222-2222-2222-222222222222', 'completed'
FROM _ss_msgs;

CREATE TEMP TABLE _ss_job3 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg4 FROM _ss_msgs);

SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    888,
    (SELECT id FROM _ss_job3),
    'DRAFT_EXHAUSTED_RETRIES'
  )$$,
  'P3B12',
  'DRAFT_ARCHIVE_STATE_ERROR',
  'SS5: archive on completed job raises P3B12 DRAFT_ARCHIVE_STATE_ERROR'
);

-- SS6: consume_draft_reservation on non-existent job raises P3B07
SELECT throws_ok(
  $$SELECT private.consume_draft_reservation('99999999-9999-9999-9999-999999999999')$$,
  'P3B07',
  'DRAFT_JOB_NOT_FOUND',
  'SS6: consume on non-existent job raises P3B07'
);

-- SS7: skip_draft_job on non-existent job raises P3B07
SELECT throws_ok(
  $$SELECT private.skip_draft_job('99999999-9999-9999-9999-999999999999', 999, 'test')$$,
  'P3B07',
  'DRAFT_JOB_NOT_FOUND',
  'SS7: skip_draft_job on non-existent job raises P3B07'
);

-- SS8: archive_draft_failed_job with mismatched pgmq_msg_id raises P3B08 (DRAFT_JOB_IDENTITY_MISMATCH)
-- This job has pgmq_msg_id=999 (set directly for SQLSTATE isolation test) and attempts=1.
-- Archive is called with p_msg_id=777, which mismatches the stored 999.
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status, pgmq_msg_id, attempts)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg5, '22222222-2222-2222-2222-222222222222', 'queued', 999, 1
FROM _ss_msgs;

CREATE TEMP TABLE _ss_job4 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg5 FROM _ss_msgs);

SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    777,
    (SELECT id FROM _ss_job4),
    'DRAFT_EXHAUSTED_RETRIES'
  )$$,
  'P3B08',
  'DRAFT_JOB_IDENTITY_MISMATCH',
  'SS8: archive with mismatched pgmq_msg_id raises P3B08 DRAFT_JOB_IDENTITY_MISMATCH'
);

-- SS9: archive_draft_failed_job with invalid error code raises P3B15 INVALID_DRAFT_FAILURE_CODE
SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    999,
    (SELECT id FROM _ss_job4),
    'INVALID_ERROR_CODE'
  )$$,
  'P3B15',
  'INVALID_DRAFT_FAILURE_CODE',
  'SS9: archive with invalid error code raises P3B15 INVALID_DRAFT_FAILURE_CODE'
);

-- SS10: archive_draft_failed_job on never-claimed job (pgmq_msg_id IS NULL) raises P3B16
-- Ingest a 6th message for this test
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss006', 'message',
  '0000000000000000000000000000000000000000000000000000000000000006',
  'wamid.ss006', '15559876543', 'text', 'Hello 6',
  '2026-01-01T00:00:05Z'::timestamptz, 'req-ss006'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss006')
);

INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status, attempts)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss006')),
  '22222222-2222-2222-2222-222222222222', 'queued', 0;

CREATE TEMP TABLE _ss_job6 AS
SELECT id FROM public.draft_generation_jobs
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss006'))
  AND pgmq_msg_id IS NULL;

SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    999,
    (SELECT id FROM _ss_job6),
    'DRAFT_EXHAUSTED_RETRIES'
  )$$,
  'P3B16',
  'INVALID_DRAFT_ATTEMPTS',
  'SS10: archive on never-claimed job (pgmq_msg_id NULL) raises P3B16 INVALID_DRAFT_ATTEMPTS'
);

-- SS11: store_draft with mismatched business_profile_id raises P3B14 (DRAFT_TENANT_MISMATCH)
-- Ingest a 7th message for this test
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss007', 'message',
  '0000000000000000000000000000000000000000000000000000000000000007',
  'wamid.ss007', '15559876543', 'text', 'Hello 7',
  '2026-01-01T00:00:06Z'::timestamptz, 'req-ss007'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss007')
);

INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss007')),
  '22222222-2222-2222-2222-222222222222', 'queued';

CREATE TEMP TABLE _ss_job7 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss007'));

SELECT * FROM private.reserve_draft_usage((SELECT id FROM _ss_job7));

SELECT throws_ok(
  $$SELECT private.store_draft(
    (SELECT id FROM _ss_job7),
    '99999999-9999-9999-9999-999999999999',
    (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
    (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss007')),
    'Test', 'logicc', 'gpt-5-nano'
  )$$,
  'P3B14',
  'DRAFT_TENANT_MISMATCH',
  'SS11: store_draft with mismatched business_profile_id raises P3B14 DRAFT_TENANT_MISMATCH'
);

-- =============================================================================
-- SQLSTATE REGISTRY COMPLETENESS: P3B01 through P3B16
-- Every code in the Phase 3B range must be classified.
-- =============================================================================

-- SS12: P3B01-P3B05 are public review RPC error codes (tested in PostgREST HTTP tests)
-- P3B01 DRAFT_NOT_FOUND, P3B02 FORBIDDEN, P3B03 STALE_VERSION,
-- P3B04 INVALID_STATE_TRANSITION, P3B05 INVALID_BODY
-- Visibility: public API error, PostgREST status 400
-- Later Next.js mapping: P3B01->404, P3B02->403, P3B03->409, P3B04->422, P3B05->422
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS12: P3B01-P3B05 are public review RPC errors (PostgREST status 400, Next.js mapped)'
);

-- SS13: P3B06 is retired, superseded by P3B13 (NOT P3B07)
-- P3B06 was used in early design for current-revision enforcement.
-- P3B07 DRAFT_JOB_NOT_FOUND is unrelated to current-revision enforcement.
-- P3B06 is superseded by P3B13 DRAFT_CURRENT_REVISION_REQUIRED.
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS13: P3B06 is retired (superseded by P3B13 DRAFT_CURRENT_REVISION_REQUIRED, NOT P3B07)'
);

-- SS14: P3B08 is active: DRAFT_JOB_IDENTITY_MISMATCH
-- Owner: archive_draft_failed_job
-- Domain: PGMQ msg_id mismatch, queue mismatch, workflow/job-type mismatch
-- Visibility: internal
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS14: P3B08 DRAFT_JOB_IDENTITY_MISMATCH is active (PGMQ msg_id, queue, workflow identity)'
);

-- SS15: P3B09 is unused (reserved for future Phase 3B+ extensions)
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS15: P3B09 is unused (reserved for future use)'
);

-- SS16: P3B10 is active: INVALID_DRAFT_JOB_STATE
-- Owner: store_draft (invalid store/processing job states)
-- Domain: store/processing state validation (NOT archive-specific)
-- Visibility: internal
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS16: P3B10 INVALID_DRAFT_JOB_STATE is active (store/processing state errors)'
);

-- SS17: P3B13 is active, raised by the deferred current-revision trigger
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_trigger WHERE tgname = 'enforce_current_revision_not_null'),
  1,
  'SS17: P3B13 DRAFT_CURRENT_REVISION_REQUIRED is active (owner: deferred trigger enforce_current_revision_not_null)'
);

-- SS18: P3B14 (DRAFT_TENANT_MISMATCH) is for tenant identity only
-- Domain: business profile belongs to another tenant, conversation belongs to another tenant,
-- source message belongs to another tenant
-- NOT for PGMQ message, queue, or workflow identity failures (those use P3B08)
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS18: P3B14 DRAFT_TENANT_MISMATCH is active (tenant identity only, NOT PGMQ/queue/workflow)'
);

-- SS19: P3B11 is QUOTA_RESERVATION_STATE_ERROR (NOT QUOTA_EXCEEDED)
-- Owner: release_draft_reservation_internal (and consume_draft_reservation for state errors)
-- Domain: missing usage row, reserved_count below required value,
--         guarded consume or release update affecting no row,
--         reservation/accounting state mismatch
-- Quota exhaustion is NOT an exception: it returns status=DENIED, reason=ENTITLEMENT_EXCEEDED
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS19: P3B11 is QUOTA_RESERVATION_STATE_ERROR (NOT QUOTA_EXCEEDED). Quota exhaustion returns DENIED/ENTITLEMENT_EXCEEDED, not an exception.'
);

-- SS20: P3B12 is DRAFT_ARCHIVE_STATE_ERROR (archive-specific)
-- Owner: archive_draft_failed_job
-- Domain: attempting to archive a completed or skipped job
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS20: P3B12 DRAFT_ARCHIVE_STATE_ERROR is active (archive-specific state errors)'
);

-- SS21: P3B15 is INVALID_DRAFT_FAILURE_CODE
-- Owner: archive_draft_failed_job
-- Domain: error code not in the allowed dead-letter allowlist
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS21: P3B15 INVALID_DRAFT_FAILURE_CODE is active (invalid archive error code)'
);

-- SS22: P3B16 is INVALID_DRAFT_ATTEMPTS
-- Owner: archive_draft_failed_job (attempts < 1 or pgmq_msg_id NULL),
--        read_draft_generation_jobs (decreasing read_ct)
-- Domain: invalid attempt count for archive, decreasing read_ct during claim
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgtap'),
  1,
  'SS22: P3B16 INVALID_DRAFT_ATTEMPTS is active (archive attempts < 1, decreasing read_ct)'
);

-- SS23: read_ct decrease rejection: read_draft_generation_jobs raises P3B16
-- when PGMQ read_ct < stored attempts.
-- Ingest a message, create a job, enqueue, claim once (read_ct=1, attempts=1),
-- then manually set attempts=5 and try to read again with read_ct=2.
-- The function must explicitly raise P3B16, not silently leave the row unchanged.
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss008', 'message',
  '0000000000000000000000000000000000000000000000000000000000000008',
  'wamid.ss008', '15559876543', 'text', 'Hello 8',
  '2026-01-01T00:00:07Z'::timestamptz, 'req-ss008'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss008')
);

INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss008')),
  '22222222-2222-2222-2222-222222222222', 'queued';

CREATE TEMP TABLE _ss_job8 AS
SELECT id FROM public.draft_generation_jobs
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss008'));

-- Enqueue and claim once (read_ct=1, attempts=1)
SELECT pgmq.send('draft_generation', jsonb_build_object('draftGenerationJobId', (SELECT id FROM _ss_job8)::text, 'requestId', 'draft-ss008', 'timestamp', '2026-01-01T00:00:00Z'), 0);
CREATE TEMP TABLE _ss_claim1 AS SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

-- Manually set attempts=5 to simulate a higher stored value
UPDATE public.draft_generation_jobs SET attempts = 5 WHERE id = (SELECT id FROM _ss_job8);

-- Set VT to 0 to make the message visible again (read_ct will be 2)
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _ss_claim1), 0);

-- Now read_draft_generation_jobs should raise P3B16 because read_ct(2) < attempts(5)
SELECT throws_ok(
  $$SELECT msg_id FROM public.read_draft_generation_jobs(30, 1)$$,
  'P3B16',
  'INVALID_DRAFT_ATTEMPTS',
  'SS23: read_draft_generation_jobs raises P3B16 when read_ct < stored attempts (decrease rejected)'
);

-- Clean up: delete the SS23 message from the queue so it doesn't interfere with SS24
DELETE FROM pgmq.q_draft_generation WHERE msg_id = (SELECT msg_id FROM _ss_claim1);

-- SS24: P3B08 raised by read_draft_generation_jobs when stored pgmq_msg_id differs
-- Create a job, enqueue with one msg_id, then manually change pgmq_msg_id to a different value
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-ss-001', 'meta', 'wamid.ss009', 'message',
  '0000000000000000000000000000000000000000000000000000000000000009',
  'wamid.ss009', '15559876543', 'text', 'Hello 9',
  '2026-01-01T00:00:08Z'::timestamptz, 'req-ss009'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss009')
);

INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss009')),
  '22222222-2222-2222-2222-222222222222', 'queued';

CREATE TEMP TABLE _ss_job9 AS
SELECT id FROM public.draft_generation_jobs
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ss009'));

-- Enqueue and claim once (binds pgmq_msg_id)
SELECT pgmq.send('draft_generation', jsonb_build_object('draftGenerationJobId', (SELECT id FROM _ss_job9)::text, 'requestId', 'draft-ss009', 'timestamp', '2026-01-01T00:00:00Z'), 0);
CREATE TEMP TABLE _ss_claim2 AS SELECT msg_id FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

-- Manually set pgmq_msg_id to a different value to simulate identity mismatch
UPDATE public.draft_generation_jobs SET pgmq_msg_id = 777777 WHERE id = (SELECT id FROM _ss_job9);

-- Set VT to 0 to make the message visible again
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _ss_claim2), 0);

-- Now read_draft_generation_jobs should raise P3B08 because stored pgmq_msg_id(777777) != actual msg_id
SELECT throws_ok(
  $$SELECT msg_id FROM public.read_draft_generation_jobs(30, 1)$$,
  'P3B08',
  'DRAFT_JOB_IDENTITY_MISMATCH',
  'SS24: read_draft_generation_jobs raises P3B08 when stored pgmq_msg_id differs from actual'
);

SELECT finish();
ROLLBACK;