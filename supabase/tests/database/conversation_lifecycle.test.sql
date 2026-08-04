-- pgTAP tests: conversation lifecycle
-- File: supabase/tests/database/conversation_lifecycle.test.sql

BEGIN;
SELECT plan(5);

-- Set up test data
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3a-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- L1: Conversation created with status open for new contact
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.l001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.l001', '15559876543', 'text', 'Hello',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-l001'
);

SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.l001')
);

SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15559876543'),
  'open',
  'L1: new conversation created with status open'
);

-- L2: Conversation status needs_human preserved on new message
UPDATE public.conversations SET status = 'needs_human' WHERE contact_phone = '15559876543';

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.l002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.l002', '15559876543', 'text', 'Second message',
  '2026-01-01T00:01:00Z'::timestamptz, 'req-l002'
);

SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.l002')
);

SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15559876543'),
  'needs_human',
  'L2: needs_human status preserved on new message'
);

-- L3: Conversation status closed preserved on new message
UPDATE public.conversations SET status = 'closed' WHERE contact_phone = '15559876543';

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.l003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.l003', '15559876543', 'text', 'Third message',
  '2026-01-01T00:02:00Z'::timestamptz, 'req-l003'
);

SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.l003')
);

SELECT is(
  (SELECT status FROM public.conversations WHERE contact_phone = '15559876543'),
  'closed',
  'L3: closed status preserved on new message (no reset to open)'
);

-- L4: Composite unique constraint on (organization_id, whatsapp_connection_id, contact_phone)
SELECT col_is_unique('public', 'conversations', ARRAY['organization_id', 'whatsapp_connection_id', 'contact_phone'], 'L4: conversations has composite unique constraint on (organization_id, whatsapp_connection_id, contact_phone)');

-- L5: Messages FK cascade on conversation delete
SELECT fk_ok('public', 'messages', 'conversation_id', 'public', 'conversations', 'id', 'L5: messages.conversation_id FK to conversations.id');

SELECT finish();
ROLLBACK;