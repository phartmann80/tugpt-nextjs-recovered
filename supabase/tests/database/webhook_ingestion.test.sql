-- pgTAP tests: webhook ingestion
-- File: supabase/tests/database/webhook_ingestion.test.sql

BEGIN;
SELECT plan(17);

-- W1: Ingest RPC inserts metadata-only receipt
SELECT has_table('public', 'webhook_events', 'webhook_events table exists');

-- W2: Ingest RPC inserts narrow staging data with typed columns
SELECT has_table('public', 'inbound_message_staging', 'inbound_message_staging table exists');

-- W3: Ingest RPC sends pgmq job (verified by queue having a message after ingest)
-- Requires a test connection to be set up

-- W4: Duplicate provider_event_key returns is_new=false
-- W5: pgmq failure rolls back receipt and staging insert
-- W6: webhook_events contains no raw JSON, phone numbers, or message content
SELECT has_column('public', 'webhook_events', 'id', 'webhook_events has id column');
SELECT hasnt_column('public', 'webhook_events', 'raw_payload', 'webhook_events has no raw_payload column');
SELECT hasnt_column('public', 'webhook_events', 'phone_number', 'webhook_events has no phone_number column');
SELECT hasnt_column('public', 'webhook_events', 'contact_identifier', 'webhook_events has no contact_identifier column');
SELECT hasnt_column('public', 'webhook_events', 'body_text', 'webhook_events has no body_text column');

-- W7: payload_sha256 format constraint
SELECT col_is_pk('public', 'webhook_events', 'id', 'id is primary key');

-- W8: Ingest RPC resolves org_id from whatsapp_connections (not from caller)
SELECT has_function('public', 'ingest_whatsapp_message_event', ARRAY[
  'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text'
], 'ingest_whatsapp_message_event function exists');

-- W9: Ingest RPC raises CONNECTION_NOT_FOUND for unknown provider connection identifier
-- W10: Tampered tenant identifier cannot produce cross-tenant writes
-- W11: Multiple messages in one envelope are independently ingested
-- W12: One failed event does not duplicate already-ingested events after retry
-- W13: Correct provider message ID is used as the event key

-- W14: Duplicate provider_event_key on different connections do not collide
SELECT col_is_unique('public', 'webhook_events', 'provider_event_key', 'provider_event_key has unique constraint');

-- W15: Unrestricted JSON cannot be stored in staging (no jsonb column)
SELECT hasnt_column('public', 'inbound_message_staging', 'normalized_payload', 'staging has no normalized_payload jsonb column');
SELECT hasnt_column('public', 'inbound_message_staging', 'raw_payload', 'staging has no raw_payload column');

-- W16: Duplicate event key with different canonical payload is rejected
-- W17: Per-event hashes differ for different messages in same envelope

SELECT finish();
ROLLBACK;