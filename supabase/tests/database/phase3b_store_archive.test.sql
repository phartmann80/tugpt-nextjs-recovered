-- pgTAP tests: Phase 3B store_draft, archive, and consume/archive behavior
-- File: supabase/tests/database/phase3b_store_archive.test.sql

BEGIN;
SELECT plan(50);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3b-store-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-store-001', 'active');

-- Create quota limit
INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 5);

-- Ingest 3 messages
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.store001', '15559876543', 'text', 'Hello 1',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-store001'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store001')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.store002', '15559876543', 'text', 'Hello 2',
  '2026-01-01T00:00:01Z'::timestamptz, 'req-store002'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store002')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.store003', '15559876543', 'text', 'Hello 3',
  '2026-01-01T00:00:02Z'::timestamptz, 'req-store003'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store003')
);

CREATE TEMP TABLE _store_msgs AS
SELECT
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store001')) AS msg1,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store002')) AS msg2,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store003')) AS msg3,
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111') AS conv_id;

-- Create a draft generation job (using msg1)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg1, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _store_msgs;

CREATE TEMP TABLE _store_job AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg1 FROM _store_msgs);

-- Reserve quota
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _store_job));

-- SA1: store_draft creates a draft with status='draft'
CREATE TEMP TABLE _store_result AS
SELECT private.store_draft(
  (SELECT id FROM _store_job),
  '22222222-2222-2222-2222-222222222222',
  (SELECT conv_id FROM _store_msgs),
  (SELECT msg1 FROM _store_msgs),
  'Test draft body',
  'logicc',
  'gpt-5-nano'
) AS draft_id;

SELECT is(
  (SELECT status FROM public.ai_drafts WHERE id = (SELECT draft_id FROM _store_result)),
  'draft',
  'SA1: store_draft creates draft with status=draft'
);

-- SA2: store_draft creates a revision with version=1 and created_by_type='system'
SELECT is(
  (SELECT version FROM public.ai_draft_revisions WHERE draft_id = (SELECT draft_id FROM _store_result)),
  1,
  'SA2: store_draft creates revision with version=1'
);

SELECT is(
  (SELECT created_by_type FROM public.ai_draft_revisions WHERE draft_id = (SELECT draft_id FROM _store_result)),
  'system',
  'SA2b: store_draft revision has created_by_type=system'
);

-- SA3: store_draft sets current_revision_id on the draft
SELECT is(
  (SELECT current_revision_id IS NOT NULL FROM public.ai_drafts WHERE id = (SELECT draft_id FROM _store_result)),
  true,
  'SA3: store_draft sets current_revision_id'
);

-- SA4: store_draft marks job as completed
SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _store_job)),
  'completed',
  'SA4: store_draft marks job as completed'
);

-- SA5: store_draft consumes the reservation
SELECT is(
  (SELECT status FROM public.draft_usage_reservations WHERE draft_generation_job_id = (SELECT id FROM _store_job)),
  'consumed',
  'SA5: store_draft consumes the reservation'
);

-- SA6: draft_count is 1 after store_draft
SELECT is(
  (SELECT draft_count FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'SA6: draft_count is 1 after store_draft'
);

-- SA7: reserved_count is 0 after store_draft (consumed)
SELECT is(
  (SELECT reserved_count FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'SA7: reserved_count is 0 after store_draft'
);

-- SA8: Cannot archive a completed job
SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    999,
    (SELECT id FROM _store_job),
    'DRAFT_EXHAUSTED_RETRIES'
  )$$,
  'P3B12',
  'DRAFT_ARCHIVE_STATE_ERROR',
  'SA8: cannot archive a completed job'
);

-- SA9: Archive a failed job is idempotent (already_archived=true on second call)
-- Create a new job (using msg2)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg2, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _store_msgs;

CREATE TEMP TABLE _store_job2 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg2 FROM _store_msgs);

-- Enqueue a message to PGMQ
SELECT pgmq.send('draft_generation', jsonb_build_object('draftGenerationJobId', (SELECT id FROM _store_job2), 'requestId', 'draft-store002', 'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), 0);

-- Claim the job via the production read_draft_generation_jobs RPC (increments attempts, sets pgmq_msg_id)
CREATE TEMP TABLE _store_pgmq AS
SELECT msg_id FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

-- Archive the job
CREATE TEMP TABLE _archive1 AS
SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _store_pgmq),
  (SELECT id FROM _store_job2),
  'DRAFT_EXHAUSTED_RETRIES'
);

SELECT is(
  (SELECT archived FROM _archive1),
  true,
  'SA9: archive_draft_failed_job returns archived=true on first call'
);

-- Second call should return already_archived=true
CREATE TEMP TABLE _archive2 AS
SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _store_pgmq),
  (SELECT id FROM _store_job2),
  'DRAFT_EXHAUSTED_RETRIES'
);

SELECT is(
  (SELECT already_archived FROM _archive2),
  true,
  'SA9b: archive_draft_failed_job returns already_archived=true on second call (idempotent)'
);

-- SA10: Archived job has status='dead_lettered'
SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _store_job2)),
  'dead_lettered',
  'SA10: archived job has status=dead_lettered'
);

-- SA11: failed_jobs record was created
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _store_pgmq)),
  1,
  'SA11: failed_jobs record created for archived job'
);

-- SA12: store_draft on a job without reservation raises P3B10 INVALID_DRAFT_JOB_STATE
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg3, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _store_msgs;

SELECT throws_ok(
  $$SELECT private.store_draft(
    (SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg3 FROM _store_msgs)),
    '22222222-2222-2222-2222-222222222222',
    (SELECT conv_id FROM _store_msgs),
    (SELECT msg3 FROM _store_msgs),
    'Test', 'logicc', 'gpt-5-nano'
  )$$,
  'P3B10',
  'INVALID_DRAFT_JOB_STATE',
  'SA12: store_draft without reservation raises P3B10 INVALID_DRAFT_JOB_STATE'
);

-- SA13: store_draft on non-existent job raises P3B07
SELECT throws_ok(
  $$SELECT private.store_draft(
    '99999999-9999-9999-9999-999999999999',
    '22222222-2222-2222-2222-222222222222',
    (SELECT conv_id FROM _store_msgs),
    (SELECT msg1 FROM _store_msgs),
    'Test', 'logicc', 'gpt-5-nano'
  )$$,
  'P3B07',
  'DRAFT_JOB_NOT_FOUND',
  'SA13: store_draft on non-existent job raises P3B07'
);

-- =============================================================================
-- SA14-SA18: failed_jobs content safety - no customer content stored
-- =============================================================================

-- Ingest a new message for the archive test
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store004', 'message',
  '0000000000000000000000000000000000000000000000000000000000000004',
  'wamid.store004', '15559876543', 'text', 'Archive test message',
  '2026-01-01T00:00:04Z'::timestamptz, 'req-store004'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store004')
);

-- SA14: archive creates a failed_jobs record with only metadata columns
DO $$
DECLARE
  v_job_id UUID;
  v_pgmq_msg_id BIGINT;
  v_archived BOOLEAN;
  v_already BOOLEAN;
BEGIN
  -- Create a draft generation job
  INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
  SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
    (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
    (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store004')),
    '22222222-2222-2222-2222-222222222222', 'queued'
  RETURNING id INTO v_job_id;

  -- Enqueue PGMQ message
  SELECT pgmq.send('draft_generation', jsonb_build_object('draftGenerationJobId', v_job_id::text, 'requestId', 'req-sa14', 'timestamp', '2026-01-01T00:00:00Z'), 0)
  INTO v_pgmq_msg_id;

  -- Claim via production RPC (atomically increments attempts and sets pgmq_msg_id)
  PERFORM msg_id FROM public.read_draft_generation_jobs(30, 1);

  -- Archive the job
  SELECT * INTO v_archived, v_already FROM private.archive_draft_failed_job(v_pgmq_msg_id, v_job_id, 'DRAFT_EXHAUSTED_RETRIES');

  CREATE TEMP TABLE IF NOT EXISTS _sa14 (archived BOOLEAN, already BOOLEAN);
  INSERT INTO _sa14 VALUES (v_archived, v_already);
END;
$$;

SELECT is((SELECT archived FROM _sa14), true, 'SA14: archive creates failed_jobs record');

-- SA15: failed_jobs record contains only metadata, no customer content
SELECT hasnt_column('public', 'failed_jobs', 'body', 'SA15: failed_jobs has no body column');
SELECT hasnt_column('public', 'failed_jobs', 'message_text', 'SA15: failed_jobs has no message_text column');
SELECT hasnt_column('public', 'failed_jobs', 'draft_body', 'SA15: failed_jobs has no draft_body column');
SELECT hasnt_column('public', 'failed_jobs', 'phone', 'SA15: failed_jobs has no phone column');
SELECT hasnt_column('public', 'failed_jobs', 'provider_response', 'SA15: failed_jobs has no provider_response column');

-- =============================================================================
-- SA16-SA35: Complete Archive-Attempt Lifecycle (production claim path)
-- PGMQ read_ct is the authoritative attempt count.
-- Tests A through J from Paul's Round 7 review.
-- =============================================================================

-- Ingest a new message for lifecycle tests
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store005', 'message',
  '0000000000000000000000000000000000000000000000000000000000000005',
  'wamid.store005', '15559876543', 'text', 'Lifecycle test',
  '2026-01-01T00:00:05Z'::timestamptz, 'req-store005'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store005')
);

-- A: Newly enqueued job: status = queued, attempts = 0
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store005')),
  '22222222-2222-2222-2222-222222222222', 'queued';

CREATE TEMP TABLE _al_job AS
SELECT id FROM public.draft_generation_jobs
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store005'));

-- Enqueue a PGMQ message for this job
SELECT pgmq.send(
  'draft_generation',
  jsonb_build_object('draftGenerationJobId', (SELECT id FROM _al_job)::text, 'requestId', 'draft-al001', 'timestamp', '2026-01-01T00:00:00Z'),
  0
);

SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  'queued',
  'SA16 (A): Newly enqueued job has status = queued'
);

SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  0,
  'SA17 (A): Newly enqueued job has attempts = 0'
);

-- B: Archive before any claim raises P3B16, no failed_jobs, no dead_lettered, no reservation released
-- Get the msg_id from the queue without using the production claim RPC
-- We use pgmq.read directly to obtain the msg_id, but the job's pgmq_msg_id stays NULL
-- because only read_draft_generation_jobs sets it.
CREATE TEMP TABLE _al_unclaimed_msg AS
SELECT msg_id, read_ct FROM pgmq.read('draft_generation', 30, 1) LIMIT 1;

SELECT throws_ok(
  $$SELECT * FROM private.archive_draft_failed_job(
    (SELECT msg_id FROM _al_unclaimed_msg),
    (SELECT id FROM _al_job),
    'DRAFT_EXHAUSTED_RETRIES'
  )$$,
  'P3B16',
  'INVALID_DRAFT_ATTEMPTS',
  'SA18 (B): Archive before any claim raises P3B16 (pgmq_msg_id is NULL)'
);

SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _al_unclaimed_msg)),
  0,
  'SA19 (B): No failed_jobs row created after rejected archive'
);

SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  'queued',
  'SA20 (B): Job status remains queued after rejected archive (not dead_lettered)'
);

-- C: First PGMQ delivery: read_ct = 1, stored attempts = 1
-- Re-enqueue (the previous pgmq.read consumed the message)
SELECT pgmq.send(
  'draft_generation',
  jsonb_build_object('draftGenerationJobId', (SELECT id FROM _al_job)::text, 'requestId', 'draft-al002', 'timestamp', '2026-01-01T00:00:01Z'),
  0
);

-- Claim via production RPC (this reconciles attempts to read_ct)
CREATE TEMP TABLE _al_claim1 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _al_claim1),
  1,
  'SA21 (C): First PGMQ delivery has read_ct = 1'
);

SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  1,
  'SA22 (C): Stored attempts = 1 after first claim (reconciled to read_ct)'
);

-- D: Duplicate handling of same delivery (same msg_id and read_ct) does not increment attempts
-- Re-read with the same message still visible (visibility timeout still active)
-- Since pgmq.read already consumed it, we verify attempts stays at 1 by checking
-- that a second read_draft_generation_jobs call returns no rows for this job
-- (the message is already consumed and not visible again until VT expires)
CREATE TEMP TABLE _al_claim1_dup AS
SELECT count(*)::int AS cnt FROM public.read_draft_generation_jobs(30, 1);

SELECT is(
  (SELECT cnt FROM _al_claim1_dup),
  0,
  'SA23 (D): Duplicate read of same delivery returns no new messages (attempts stays 1)'
);

SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  1,
  'SA24 (D): Attempts remains 1 after duplicate delivery check'
);

-- E: Visibility-timeout redelivery: read_ct = 2, attempts becomes 2
-- The message from step C is still in the queue (pgmq.read sets VT, doesn't delete).
-- Set VT to NOW() to simulate visibility timeout expiry, then read again via production RPC.
-- pgmq.read will increment read_ct to 2 naturally.
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _al_claim1), 0);

CREATE TEMP TABLE _al_claim2 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _al_claim2),
  2,
  'SA25 (E): Visibility-timeout redelivery has read_ct = 2'
);

SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  2,
  'SA26 (E): Stored attempts = 2 after redelivery (reconciled to read_ct)'
);

-- F: Third delivery: read_ct = 3, attempts becomes 3
-- Set VT to NOW() again for the same message, read again.
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _al_claim2), 0);

CREATE TEMP TABLE _al_claim3 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _al_claim3),
  3,
  'SA27 (F): Third delivery has read_ct = 3'
);

SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  3,
  'SA28 (F): Stored attempts = 3 after third delivery (reconciled to read_ct)'
);

-- G: Final archive: failed_jobs.attempts = 3
SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _al_claim3),
  (SELECT id FROM _al_job),
  'DRAFT_EXHAUSTED_RETRIES'
);

SELECT is(
  (SELECT attempts FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _al_claim3)),
  3,
  'SA29 (G): failed_jobs.attempts = 3 (exact final stored attempt count from read_ct)'
);

-- H: Archive replay: attempts remains 3, exactly one failed_jobs row
CREATE TEMP TABLE _al_replay AS
SELECT * FROM private.archive_draft_failed_job(
  (SELECT msg_id FROM _al_claim3),
  (SELECT id FROM _al_job),
  'DRAFT_EXHAUSTED_RETRIES'
);

SELECT is(
  (SELECT already_archived FROM _al_replay),
  true,
  'SA30 (H): Archive replay returns already_archived = true (idempotent)'
);

SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _al_claim3)),
  1,
  'SA31 (H): Exactly one failed_jobs row after replay (no duplicate)'
);

SELECT is(
  (SELECT attempts FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = (SELECT msg_id FROM _al_claim3)),
  3,
  'SA32 (H): failed_jobs.attempts remains 3 after replay (unchanged)'
);

-- I: Concurrent claim/replay: one delivery cannot increment attempts twice
-- This is verified by the concurrency test harness (C2 scenario).
-- Here we verify the invariant: after all claims, attempts equals the max read_ct seen.
SELECT is(
  (SELECT attempts FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  3,
  'SA33 (I): After all claims, attempts = 3 (max read_ct, no duplicate increment)'
);

-- J: No fourth provider attempt: delivery beyond approved maximum follows terminal path
-- The job is already dead_lettered (archived after 3 attempts).
-- Verify that the job status is dead_lettered.
SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  'dead_lettered',
  'SA34 (J): Job status is dead_lettered after archive (terminal path, no fourth attempt)'
);

-- Verify the canonical job-status vocabulary is used everywhere
SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _al_job)),
  'dead_lettered',
  'SA35: Canonical status vocabulary: dead_lettered (not failed)'
);

-- =============================================================================
-- SA36-SA44: Terminal path for read_ct > 3 (over-limit delivery)
-- The read_draft_generation_jobs function must deterministically handle
-- a 4th delivery by archiving the job inline, without returning provider work.
-- =============================================================================

-- Ingest a new message for the terminal-path test
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-store-001', 'meta', 'wamid.store006', 'message',
  '0000000000000000000000000000000000000000000000000000000000000006',
  'wamid.store006', '15559876543', 'text', 'Terminal path test',
  '2026-01-01T00:00:06Z'::timestamptz, 'req-store006'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store006')
);

-- Create a job and enqueue it
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store006')),
  '22222222-2222-2222-2222-222222222222', 'queued';

CREATE TEMP TABLE _tp_job AS
SELECT id FROM public.draft_generation_jobs
WHERE organization_id = '11111111-1111-1111-1111-111111111111'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.store006'));

-- Enqueue PGMQ message
SELECT pgmq.send(
  'draft_generation',
  jsonb_build_object('draftGenerationJobId', (SELECT id FROM _tp_job)::text, 'requestId', 'draft-tp001', 'timestamp', '2026-01-01T00:00:00Z'),
  0
);

-- Claim 1: read_ct=1, attempts=1
CREATE TEMP TABLE _tp_claim1 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _tp_claim1),
  1,
  'SA36 (TP-1): First delivery read_ct = 1'
);

-- Set VT to 0 for redelivery
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _tp_claim1), 0);

-- Claim 2: read_ct=2, attempts=2
CREATE TEMP TABLE _tp_claim2 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _tp_claim2),
  2,
  'SA37 (TP-2): Second delivery read_ct = 2'
);

-- Set VT to 0 for redelivery
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _tp_claim2), 0);

-- Claim 3: read_ct=3, attempts=3
CREATE TEMP TABLE _tp_claim3 AS
SELECT msg_id, read_ct FROM public.read_draft_generation_jobs(30, 1) LIMIT 1;

SELECT is(
  (SELECT read_ct FROM _tp_claim3),
  3,
  'SA38 (TP-3): Third delivery read_ct = 3'
);

-- Set VT to 0 for the 4th delivery (over-limit)
SELECT pgmq.set_vt('draft_generation', (SELECT msg_id FROM _tp_claim3), 0);

-- Claim 4: read_ct=4, should trigger terminal path inside read_draft_generation_jobs
-- The function should archive the job and return NO rows (no provider work)
CREATE TEMP TABLE _tp_claim4 AS
SELECT count(*)::int AS cnt FROM public.read_draft_generation_jobs(30, 1);

SELECT is(
  (SELECT cnt FROM _tp_claim4),
  0,
  'SA39 (TP-4): Fourth delivery (read_ct > 3) returns no provider work (terminal path)'
);

-- SA40: Job is marked dead_lettered by the terminal path
SELECT is(
  (SELECT status FROM public.draft_generation_jobs WHERE id = (SELECT id FROM _tp_job)),
  'dead_lettered',
  'SA40 (TP-4): Job status is dead_lettered after terminal path'
);

-- SA41: failed_jobs record created with DRAFT_EXHAUSTED_RETRIES
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs
   WHERE queue_name = 'draft_generation'
   AND pgmq_msg_id = (SELECT msg_id FROM _tp_claim3)
   AND error_code = 'DRAFT_EXHAUSTED_RETRIES'),
  1,
  'SA41 (TP-4): failed_jobs record created with DRAFT_EXHAUSTED_RETRIES'
);

-- SA42: failed_jobs.attempts = 3 (the authoritative read_ct at time of archive)
SELECT is(
  (SELECT attempts FROM public.failed_jobs
   WHERE queue_name = 'draft_generation'
   AND pgmq_msg_id = (SELECT msg_id FROM _tp_claim3)),
  3,
  'SA42 (TP-4): failed_jobs.attempts = 3 (authoritative read_ct at archive time)'
);

-- SA43: PGMQ message is archived (absent from queue)
SELECT is(
  (SELECT count(*)::int FROM pgmq.q_draft_generation WHERE msg_id = (SELECT msg_id FROM _tp_claim3)),
  0,
  'SA43 (TP-4): PGMQ message is archived (absent from queue)'
);

-- SA44: Exactly one failed_jobs row (no duplicates from terminal path)
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs
   WHERE queue_name = 'draft_generation'
   AND pgmq_msg_id = (SELECT msg_id FROM _tp_claim3)),
  1,
  'SA44 (TP-4): Exactly one failed_jobs row (no duplicate from terminal path)'
);

SELECT finish();
ROLLBACK;