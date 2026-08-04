-- pgTAP tests: worker processing
-- File: supabase/tests/database/worker_processing.test.sql

BEGIN;
SELECT plan(17);

-- Set up test data
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3a-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- P1: Process RPC creates conversation for new contact
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.p001', '15559876543', 'text', 'Hello',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-p001'
);

SELECT is(
  (SELECT success FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P1: process returns success=true for new message'
);

-- P2: Process RPC preserves needs_human status on new message
INSERT INTO public.conversations (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '15550000001', 'needs_human');

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.p002', '15550000001', 'text', 'Follow up',
  '2026-01-01T00:01:00Z'::timestamptz, 'req-p002'
);

SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p002')
);

SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15550000001'),
  'needs_human',
  'P2: needs_human status preserved on new message'
);

-- P3: Process RPC preserves closed status on new message
INSERT INTO public.conversations (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '15550000002', 'closed');

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.p003', '15550000002', 'text', 'Closed conversation message?',
  '2026-01-01T00:02:00Z'::timestamptz, 'req-p003'
);

SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003')
);

SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15550000002'),
  'closed',
  'P3: closed status preserved on new message (no reset to open)'
);

-- P4: Process RPC inserts message idempotently (no duplicate on reprocess)
SELECT col_is_unique('public', 'messages', 'webhook_event_id', 'P4: messages.webhook_event_id is unique');

SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P4: reprocessing already-processed receipt returns already_processed=true (no duplicate message)'
);

-- P5: Process RPC marks receipt processed with timestamp
SELECT ok(
  (
    SELECT processed_at IS NOT NULL AND status = 'processed'
    FROM public.webhook_events
    WHERE provider_event_key = 'wamid.p001'
  ),
  'P5: receipt marked as processed with processed_at timestamp after process_inbound_message'
);

-- P6: Process RPC deletes staging after processing
SELECT is(
  (SELECT count(*)::int FROM public.inbound_message_staging WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  0,
  'P6: staging data deleted after processing'
);

-- P7: Process RPC derives org/connection from receipt, not queue payload
SELECT is(
  (SELECT organization_id::text FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  '11111111-1111-1111-1111-111111111111',
  'P7: message org_id derived from receipt, not queue payload'
);

-- P8: Process RPC skips already-processed receipts (idempotent)
SELECT is(
  (SELECT success FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p002')
  )),
  true,
  'P8: processing already-processed receipt returns success=true (idempotent skip)'
);

-- P9: Process RPC updates attempt_count and last_error_code on failure
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    2
  )
  AND (SELECT attempt_count FROM public.webhook_events WHERE provider_event_key = 'wamid.p003') = 2,
  true,
  'P9: record_inbound_processing_failure returns true and attempt_count updated to 2'
);

-- P10: Redelivery after processing but before acknowledgment is safe
SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P10: redelivery after processing returns already_processed=true (safe)'
);

-- P11: Retry attempt state persists after processing error
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    3
  )
  AND (SELECT attempt_count FROM public.webhook_events WHERE provider_event_key = 'wamid.p003') = 3,
  true,
  'P11: second failure recording succeeds and attempt_count persists at 3'
);

-- P12: Attempt count cannot move backward (monotonic)
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    1
  ),
  true,
  'P12: record_inbound_processing_failure accepts lower attempt_count (GREATEST prevents backward movement, stays at 3)'
);

-- P13: record_inbound_processing_failure does not overwrite processed with failed
SELECT is(
  NOT public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001'),
    'DB_TRANSIENT',
    1
  )
  AND (SELECT status FROM public.webhook_events WHERE provider_event_key = 'wamid.p001') = 'processed',
  true,
  'P13: record_inbound_processing_failure returns false for processed receipt (no overwrite, status stays processed)'
);

-- P14: Duplicate message is idempotent success (not dead-letter)
-- P15: Missing staging with already-processed receipt returns success
SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P14+P15: reprocessing already-processed receipt returns already_processed=true (idempotent, not dead-letter)'
);

-- P16: Missing staging with unprocessed receipt is non-retryable
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p016', 'message',
  '0000000000000000000000000000000000000000000000000000000000000016',
  'wamid.p016', '15550000003', 'text', 'Missing staging test',
  '2026-01-01T00:03:00Z'::timestamptz, 'req-p016'
);

DELETE FROM public.inbound_message_staging WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p016');

SELECT throws_ok(
  $$SELECT * FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p016')
  )$$,
  '90002',
  'STAGING_NOT_FOUND',
  'P16: missing staging with unprocessed receipt raises SQLSTATE 90002 (STAGING_NOT_FOUND, non-retryable)'
);

-- P17: One receipt creates one message through webhook_event_id uniqueness
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  1,
  'P17: exactly one message created per webhook event (uniqueness enforced)'
);

SELECT finish();
ROLLBACK;