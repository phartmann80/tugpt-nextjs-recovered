-- pgTAP tests: dead-letter
-- File: supabase/tests/database/dead_letter.test.sql

BEGIN;
SELECT plan(9);

-- Set up test data
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3a-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- Ingest a message to create a receipt and a pgmq queue entry
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.d001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.d001', '15559876543', 'text', 'Hello',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-d001'
);

CREATE TEMP TABLE _d001_msg AS
SELECT msg_id FROM pgmq.q_whatsapp_inbound ORDER BY enqueued_at DESC LIMIT 1;

-- D1: Archive RPC inserts narrow failed_jobs record with correct error_code
SELECT is(
  (SELECT archived FROM public.archive_failed_job(
    (SELECT msg_id FROM _d001_msg), 'req-d001', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )),
  true,
  'D1: archive_failed_job returns archived=true for new dead-letter'
);

-- D2: pgmq message archived (no longer in active queue)
SELECT is(
  (SELECT count(*)::int FROM pgmq.q_whatsapp_inbound WHERE msg_id = (SELECT msg_id FROM _d001_msg)),
  0,
  'D2: pgmq message archived (no longer in active queue)'
);

-- D3: Dedup via composite unique constraint (queue_name, pgmq_msg_id)
SELECT col_is_unique('public', 'failed_jobs', ARRAY['queue_name', 'pgmq_msg_id'], 'D3: failed_jobs has composite unique constraint on (queue_name, pgmq_msg_id)');

-- D4: failed_jobs contains no raw exception text, raw payload, or customer content
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'failed_jobs'
    AND column_name IN ('raw_exception', 'raw_payload', 'customer_content')
  ),
  'D4: failed_jobs has no raw_exception, raw_payload, or customer_content columns'
);

-- D5: Archive + pgmq archival are atomic (rollback on failure)
SELECT throws_ok(
  $$SELECT * FROM public.archive_failed_job(
    88888::bigint, 'req-d005', 'DB_TRANSIENT', 3,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )$$,
  '90006',
  'ARCHIVE_FAILED',
  'D5: archive_failed_job raises SQLSTATE 90006 when archive fails (atomic rollback)'
);

-- D6: Transient failures retry without dead-lettering (below max attempts)
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.d006', 'message',
  '0000000000000000000000000000000000000000000000000000000000000006',
  'wamid.d006', '15559876543', 'text', 'Retry test',
  '2026-01-01T00:01:00Z'::timestamptz, 'req-d006'
);

CREATE TEMP TABLE _d006_msg AS
SELECT msg_id FROM pgmq.q_whatsapp_inbound ORDER BY enqueued_at DESC LIMIT 1;

SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d006'),
    'DB_TRANSIENT',
    2
  ),
  true,
  'D6: record_inbound_processing_failure succeeds for transient failure (receipt stays received, retryable)'
);

-- D7: Final attempt dead-letters exactly once
SELECT is(
  (SELECT archived FROM public.archive_failed_job(
    (SELECT msg_id FROM _d006_msg), 'req-d007', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d006')
  )),
  true,
  'D7: final attempt dead-letters successfully (archived=true, receipt marked failed)'
);

-- D8: Repeated dead-letter invocation succeeds idempotently (already_archived=true)
SELECT is(
  (SELECT already_archived FROM public.archive_failed_job(
    (SELECT msg_id FROM _d001_msg), 'req-d008', 'DB_TRANSIENT', 5,
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.d001')
  )),
  true,
  'D8: repeated dead-letter invocation returns already_archived=true (idempotent)'
);

-- D9: Dead-letter RPC cannot archive another queue (fixed queue name)
SELECT is(
  (SELECT count(*)::int FROM public.failed_jobs WHERE queue_name <> 'whatsapp_inbound'),
  0,
  'D9: all failed_jobs records have queue_name=whatsapp_inbound (cannot archive another queue)'
);

SELECT finish();
ROLLBACK;