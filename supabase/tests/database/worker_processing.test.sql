-- pgTAP tests: worker processing
-- File: supabase/tests/database/worker_processing.test.sql

BEGIN;
SELECT plan(17);

-- Set up test data
INSERT INTO public.organizations (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- P1: Process RPC creates conversation for new contact
SELECT has_function('public', 'process_inbound_message', ARRAY['uuid'], 'process_inbound_message function exists');

-- Ingest a message to create a receipt + staging
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.p001', '15559876543', 'text', 'Hello',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-p001'
);

-- Process the message
SELECT is(
  (SELECT success FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P1: process returns success=true for new message'
);

-- Verify conversation was created
SELECT is(
  (SELECT count(*)::int FROM public.conversations WHERE contact_phone = '15559876543'),
  1,
  'P1: conversation created for new contact'
);

-- Verify conversation status is open
SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15559876543'),
  'open',
  'P1: new conversation has status open'
);

-- P2: Process RPC preserves needs_human status on new message
-- Create a conversation with needs_human status, then process a new message for same contact
INSERT INTO public.conversations (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '15550000001', 'needs_human');

-- Ingest and process a new message for the needs_human conversation
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

-- P3: Process RPC preserves closed status on new message (no reset to open)
INSERT INTO public.conversations (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '15550000002', 'closed');

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.p003', '15550000002', 'text', 'Reopen?',
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
SELECT col_is_unique('public', 'messages', 'webhook_event_id', 'messages.webhook_event_id is unique');

-- Re-process the first message (already processed)
SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P4: reprocessing already-processed receipt returns already_processed=true'
);

-- Verify no duplicate message was created
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  1,
  'P4: no duplicate message on reprocess (idempotent)'
);

-- P5: Process RPC marks receipt processed
SELECT has_column('public', 'webhook_events', 'processed_at', 'webhook_events has processed_at column');

SELECT is(
  (SELECT status FROM public.webhook_events WHERE provider_event_key = 'wamid.p001'),
  'processed',
  'P5: receipt marked as processed after process_inbound_message'
);

SELECT is_not(
  (SELECT processed_at FROM public.webhook_events WHERE provider_event_key = 'wamid.p001'),
  NULL,
  'P5: processed_at is set after processing'
);

-- P6: Process RPC deletes staging after processing
SELECT is(
  (SELECT count(*)::int FROM public.inbound_message_staging WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  0,
  'P6: staging data deleted after processing'
);

-- P7: Process RPC derives org/connection from receipt, not queue payload
-- The process RPC takes only p_webhook_event_id; it loads the receipt to get org_id and connection_id
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
SELECT has_column('public', 'webhook_events', 'attempt_count', 'webhook_events has attempt_count column');
SELECT has_column('public', 'webhook_events', 'last_error_code', 'webhook_events has last_error_code column');

-- Record a processing failure
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    2
  ),
  true,
  'P9: record_inbound_processing_failure returns true for received receipt'
);

SELECT is(
  (SELECT attempt_count FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
  2,
  'P9: attempt_count updated to 2 after record_inbound_processing_failure'
);

SELECT is(
  (SELECT last_error_code FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
  'DB_TRANSIENT',
  'P9: last_error_code set to DB_TRANSIENT after failure'
);

-- P10: Redelivery after processing but before acknowledgment is safe
-- Process p001 again (already processed) — should return success with already_processed=true
-- This proves redelivery is safe: no duplicate message, no error
SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P10: redelivery after processing returns already_processed=true (safe)'
);

-- P11: Retry attempt state persists after processing error
SELECT has_function('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'record_inbound_processing_failure function exists');

-- Record another failure on p003 (attempt 3)
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    3
  ),
  true,
  'P11: second failure recording succeeds'
);

SELECT is(
  (SELECT attempt_count FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
  3,
  'P11: attempt_count persists at 3 after second failure recording'
);

-- P12: Attempt count cannot move backward (monotonic)
-- Try to record a lower attempt count
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
    'DB_TRANSIENT',
    1
  ),
  true,
  'P12: record_inbound_processing_failure accepts lower attempt_count'
);

SELECT is(
  (SELECT attempt_count FROM public.webhook_events WHERE provider_event_key = 'wamid.p003'),
  3,
  'P12: attempt_count stays at 3 (GREATEST prevents backward movement)'
);

-- P13: record_inbound_processing_failure does not overwrite processed with failed
-- p001 is already processed; recording a failure should return false
SELECT is(
  public.record_inbound_processing_failure(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001'),
    'DB_TRANSIENT',
    1
  ),
  false,
  'P13: record_inbound_processing_failure returns false for processed receipt (no overwrite)'
);

SELECT is(
  (SELECT status FROM public.webhook_events WHERE provider_event_key = 'wamid.p001'),
  'processed',
  'P13: processed receipt status unchanged after failure recording attempt'
);

-- P14: Duplicate message is idempotent success (not dead-letter)
-- Re-process p002 (already processed) — should return success, not error
SELECT is(
  (SELECT success FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p002')
  )),
  true,
  'P14: duplicate message processing returns success (idempotent, not dead-letter)'
);

-- P15: Missing staging with already-processed receipt returns success
-- p001 is processed and staging is deleted — reprocessing should return already_processed=true
SELECT is(
  (SELECT already_processed FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')
  )),
  true,
  'P15: missing staging with already-processed receipt returns already_processed=true'
);

-- P16: Missing staging with unprocessed receipt is non-retryable
-- Ingest a new event but don't process it, then delete its staging manually
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.p016', 'message',
  '0000000000000000000000000000000000000000000000000000000000000016',
  'wamid.p016', '15559999999', 'text', 'Test staging delete',
  '2026-01-01T00:03:00Z'::timestamptz, 'req-p016'
);

-- Delete staging to simulate missing staging
DELETE FROM public.inbound_message_staging WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p016');

SELECT throws_ok(
  $$SELECT * FROM public.process_inbound_message(
    (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p016')
  )$$,
  'STAGING_NOT_FOUND',
  'P16: missing staging with unprocessed receipt raises STAGING_NOT_FOUND (non-retryable)'
);

-- P17: One receipt creates one message through webhook_event_id uniqueness
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.p001')),
  1,
  'P17: exactly one message created per webhook event (uniqueness enforced)'
);

SELECT finish();
ROLLBACK;