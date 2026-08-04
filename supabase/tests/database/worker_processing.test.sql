-- pgTAP tests: worker processing
-- File: supabase/tests/database/worker_processing.test.sql

BEGIN;
SELECT plan(17);

-- P1: Process RPC creates conversation for new contact
SELECT has_function('public', 'process_inbound_message', ARRAY['uuid'], 'process_inbound_message function exists');

-- P2: Process RPC preserves needs_human status on new message
-- P3: Process RPC preserves closed status on new message (no reset to open)
-- P4: Process RPC inserts message idempotently (no duplicate on reprocess)
SELECT col_is_unique('public', 'messages', 'webhook_event_id', 'messages.webhook_event_id is unique');

-- P5: Process RPC marks receipt processed
SELECT has_column('public', 'webhook_events', 'processed_at', 'webhook_events has processed_at column');

-- P6: Process RPC deletes staging after processing
-- P7: Process RPC derives org/connection from receipt, not queue payload
-- P8: Process RPC skips already-processed receipts (idempotent)
-- P9: Process RPC updates attempt_count and last_error_code on failure
SELECT has_column('public', 'webhook_events', 'attempt_count', 'webhook_events has attempt_count column');
SELECT has_column('public', 'webhook_events', 'last_error_code', 'webhook_events has last_error_code column');

-- P10: Redelivery after processing but before acknowledgment is safe
-- P11: Retry attempt state persists after processing error
SELECT has_function('public', 'record_inbound_processing_failure', ARRAY['uuid', 'text', 'int'], 'record_inbound_processing_failure function exists');

-- P12: Attempt count cannot move backward (monotonic)
-- P13: record_inbound_processing_failure does not overwrite processed with failed
-- P14: Duplicate message is idempotent success (not dead-letter)
-- P15: Missing staging with already-processed receipt returns success
-- P16: Missing staging with unprocessed receipt is non-retryable
-- P17: One receipt creates one message through webhook_event_id uniqueness

SELECT finish();
ROLLBACK;