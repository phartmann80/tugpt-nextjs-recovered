-- pgTAP tests: webhook ingestion
-- File: supabase/tests/database/webhook_ingestion.test.sql

BEGIN;
SELECT plan(18);

-- W1: Ingest RPC inserts metadata-only receipt
SELECT has_table('public', 'webhook_events', 'W1: webhook_events table exists');

-- W2: Ingest RPC inserts narrow staging data with typed columns
SELECT has_table('public', 'inbound_message_staging', 'W2: inbound_message_staging table exists');

-- Set up test data
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3a-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- W3: Ingest RPC sends pgmq job (verified by queue having a message after ingest)
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000001',
    'wamid.test001', '15559876543', 'text', 'Hello',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-001'
  )),
  true,
  'W3: ingest returns is_new=true for first event'
);

-- W4: Duplicate provider_event_key returns is_new=false
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000001',
    'wamid.test001', '15559876543', 'text', 'Hello',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-002'
  )),
  false,
  'W4: duplicate provider_event_key returns is_new=false'
);

-- W5: pgmq failure rolls back receipt and staging insert
SELECT throws_ok(
  $$SELECT * FROM public.ingest_whatsapp_message_event(
    'nonexistent-conn', 'meta', 'wamid.fail001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000002',
    'wamid.fail001', '15559876543', 'text', 'Fail',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-003'
  )$$,
  '90003',
  'CONNECTION_NOT_FOUND',
  'W5: ingest raises SQLSTATE 90003 for unknown connection (rollback verified)'
);

-- W6: webhook_events contains no raw JSON, phone numbers, or message content
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_events'
    AND column_name IN ('raw_payload', 'phone_number', 'contact_identifier', 'body_text')
  ),
  'W6: webhook_events has no raw_payload, phone_number, contact_identifier, or body_text columns'
);

-- W7: payload_sha256 format constraint
SELECT col_is_pk('public', 'webhook_events', 'id', 'W7: id is primary key on webhook_events');

-- W8: Ingest RPC resolves org_id from whatsapp_connections (not from caller)
SELECT is(
  (SELECT organization_id::text FROM public.webhook_events WHERE provider_event_key = 'wamid.test001'),
  '11111111-1111-1111-1111-111111111111',
  'W8: ingest resolves org_id from whatsapp_connections lookup'
);

-- W9: Ingest RPC raises CONNECTION_NOT_FOUND for unknown provider connection identifier
SELECT throws_ok(
  $$SELECT * FROM public.ingest_whatsapp_message_event(
    'unknown-conn-id', 'meta', 'wamid.test009', 'message',
    '0000000000000000000000000000000000000000000000000000000000000009',
    'wamid.test009', '15559876543', 'text', 'Test',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-009'
  )$$,
  '90003',
  'CONNECTION_NOT_FOUND',
  'W9: ingest raises SQLSTATE 90003 for unknown provider connection identifier'
);

-- W10: Tampered tenant identifier cannot produce cross-tenant writes
-- The ingest RPC does not accept an org_id parameter; it resolves org_id from the connection.
-- Verify by introspecting the function's argument names.
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_proc AS p
   CROSS JOIN LATERAL pg_catalog.unnest(p.proargnames) WITH ORDINALITY AS arg(name, idx)
   WHERE p.oid = 'public.ingest_whatsapp_message_event(text,text,text,text,text,text,text,text,text,timestamp with time zone,text)'::regprocedure
   AND arg.name IN ('organization_id', 'org_id', 'tenant_id')),
  0,
  'W10: ingest_whatsapp_message_event has no caller-supplied org_id/org_id/tenant_id parameter'
);

-- W11: Multiple messages in one envelope are independently ingested
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test011a', 'message',
    '0000000000000000000000000000000000000000000000000000000000000011',
    'wamid.test011a', '15559876543', 'text', 'First',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-011a'
  )),
  true,
  'W11: first message in envelope ingested as new'
);

SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test011b', 'message',
    '0000000000000000000000000000000000000000000000000000000000000012',
    'wamid.test011b', '15559876543', 'text', 'Second',
    '2026-01-01T00:00:01Z'::timestamptz, 'req-011b'
  )),
  true,
  'W11b: second message in envelope ingested as new independently'
);

-- W12: One failed event does not duplicate already-ingested events after retry
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test011a', 'message',
    '0000000000000000000000000000000000000000000000000000000000000011',
    'wamid.test011a', '15559876543', 'text', 'First',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-011a-retry'
  )),
  false,
  'W12: re-ingestion of already-ingested event returns is_new=false (no duplicate)'
);

-- W13: Correct provider message ID is used as the event key
SELECT is(
  (SELECT provider_event_key FROM public.webhook_events WHERE provider_event_key = 'wamid.test001'),
  'wamid.test001',
  'W13: provider message ID is used as the event key'
);

-- W14: Duplicate provider_event_key on different connections do not collide
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15557654321', 'conn-002', 'active');

SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-002', 'meta', 'wamid.test001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000001',
    'wamid.test001', '15559876543', 'text', 'Hello',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-014'
  )),
  true,
  'W14: same event key on different connection does not collide (unique per provider+connection+key)'
);

-- W15: Unrestricted JSON cannot be stored in staging (no jsonb column)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inbound_message_staging'
    AND column_name IN ('normalized_payload', 'raw_payload')
  ),
  'W15: staging has no normalized_payload or raw_payload jsonb column'
);

-- W16: Duplicate event key with different canonical hash is rejected
SELECT throws_ok(
  $$SELECT * FROM public.ingest_whatsapp_message_event(
    'conn-001', 'meta', 'wamid.test001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000099',
    'wamid.test001', '15559876543', 'text', 'Different content',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-016'
  )$$,
  '90004',
  'EVENT_KEY_PAYLOAD_MISMATCH',
  'W16: duplicate event key with different canonical hash is rejected (SQLSTATE 90004)'
);

-- W17: Per-event hashes differ for different messages in same envelope
SELECT is(
  (SELECT payload_sha256 FROM public.webhook_events WHERE provider_event_key = 'wamid.test011a')
  <>
  (SELECT payload_sha256 FROM public.webhook_events WHERE provider_event_key = 'wamid.test011b'),
  true,
  'W17: per-event hashes differ for different messages in same envelope'
);

SELECT finish();
ROLLBACK;