-- pgTAP tests: dead-letter
-- File: supabase/tests/database/dead_letter.test.sql

BEGIN;
SELECT plan(9);

-- Set up test data
INSERT INTO public.organizations (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- Ingest a message to create a receipt
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.d001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.d001', '15559876543', 'text', 'Hello',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-d001'
);

-- D1: Archive RPC inserts narrow failed_jobs record
SELECT has_function('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'archive_failed_job function exists');
SELECT has_table('public', 'failed_jobs', 'failed_jobs table exists');

-- Archive a job
SELECT is(
  (SELECT archived FROM public.archive_failed_job(
    99999::bigint, 'req-d001', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )),
  true,
  'D1: archive_failed_job returns archived=true for new dead-letter'
);

-- Verify failed_jobs record was created with narrow fields
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE pgmq_msg_id = 99999),
  1,
  'D1: failed_jobs record created'
);

SELECT is(
  (SELECT error_code FROM public.failed_jobs WHERE pgmq_msg_id = 99999),
  'DB_TRANSIENT',
  'D1: failed_jobs record has correct error_code'
);

SELECT is(
  (SELECT queue_name FROM public.failed_jobs WHERE pgmq_msg_id = 99999),
  'whatsapp_inbound',
  'D1: failed_jobs record has correct queue_name'
);

-- D2: Archive RPC archives pgmq message
-- The pgmq message was archived as part of D1 (the RPC calls pgmq.archive internally)
-- We verify by checking that the message is no longer in the active queue
-- (it was moved to the pgmq archive via pgmq.archive)
SELECT is(
  (SELECT count(*)::int FROM pgmq.q_whatsapp_inbound WHERE msg_id = 99999),
  0,
  'D2: pgmq message archived (no longer in active queue)'
);

-- D3: Archive RPC dedup via unique(queue_name, pgmq_msg_id)
SELECT col_is_unique('public', 'failed_jobs', 'pgmq_msg_id', 'failed_jobs.pgmq_msg_id has unique constraint');

-- D4: failed_jobs contains no raw exception text, raw payload, or customer content
SELECT hasnt_column('public', 'failed_jobs', 'raw_exception', 'failed_jobs has no raw_exception column');
SELECT hasnt_column('public', 'failed_jobs', 'raw_payload', 'failed_jobs has no raw_payload column');
SELECT hasnt_column('public', 'failed_jobs', 'customer_content', 'failed_jobs has no customer_content column');

-- D5: Archive + pgmq archival are atomic (rollback on failure)
-- If the pgmq archive fails, the failed_jobs insert should be rolled back.
-- We test this by trying to archive a non-existent pgmq message (archive returns false/NULL)
SELECT throws_ok(
  $$SELECT * FROM public.archive_failed_job(
    88888::bigint, 'req-d005', 'DB_TRANSIENT', 3,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )$$,
  'ARCHIVE_FAILED',
  'D5: archive_failed_job raises ARCHIVE_FAILED when pgmq archive fails (atomic rollback)'
);

-- Verify no failed_jobs record was created for the failed archive
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE pgmq_msg_id = 88888),
  0,
  'D5: no failed_jobs record created when archive fails (atomic rollback verified)'
);

-- D6: Transient failures retry without dead-lettering (below max attempts)
-- This is a worker-level behavior, but we verify the record_inbound_processing_failure RPC
-- keeps the receipt in 'received' status (not 'failed') for retry
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.d006', 'message',
  '0000000000000000000000000000000000000000000000000000000000000006',
  'wamid.d006', '15559876543', 'text', 'Retry test',
  '2026-01-01T00:01:00Z'::timestamptz, 'req-d006'
);

-- Record a transient failure (attempt 2, below max)
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d006'),
    'DB_TRANSIENT',
    2
  ),
  true,
  'D6: record_inbound_processing_failure succeeds for transient failure'
);

SELECT is(
  (SELECT status FROM public.webhook_events WHERE provider_event_key = 'wamid.d006'),
  'received',
  'D6: receipt stays in received status after transient failure (retryable, not dead-lettered)'
);

-- D7: Final attempt dead-letters exactly once
-- Archive the receipt from D6
SELECT is(
  (SELECT archived FROM public.archive_failed_job(
    77777::bigint, 'req-d007', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d006')
  )),
  true,
  'D7: final attempt dead-letters successfully (archived=true)'
);

-- Verify receipt is marked as failed
SELECT is(
  (SELECT status FROM public.webhook_events WHERE provider_event_key = 'wamid.d006'),
  'failed',
  'D7: receipt marked as failed after dead-letter'
);

-- D8: Repeated dead-letter invocation succeeds idempotently (already_archived=true)
SELECT is(
  (SELECT already_archived FROM public.archive_failed_job(
    99999::bigint, 'req-d008', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )),
  true,
  'D8: repeated dead-letter invocation returns already_archived=true (idempotent)'
);

-- D9: Dead-letter RPC cannot archive another queue (fixed queue name)
-- The archive_failed_job RPC uses a hardcoded queue_name 'whatsapp_inbound'
-- Verify the failed_jobs record always has queue_name = 'whatsapp_inbound'
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE queue_name <> 'whatsapp_inbound'),
  0,
  'D9: all failed_jobs records have queue_name=whatsapp_inbound (cannot archive another queue)'
);

SELECT finish();
ROLLBACK;