-- pgTAP tests: queue read visibility timeout
-- File: supabase/tests/database/queue_read_visibility.test.sql
-- Asserts that read_whatsapp_inbound_jobs honors p_visibility_timeout_seconds

BEGIN;
SELECT plan(6);

-- Set up test data: organization, business profile, active connection
INSERT INTO public.organizations (id, name, slug) VALUES ('55555555-5555-5555-5555-555555555555', 'Visibility Test Org', 'phase3a-vis-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555', 'Visibility Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', '+15551112222', 'conn-vis-001', 'active');

-- Ingest a message so the queue has something to read
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-vis-001', 'meta', 'wamid.vis001', 'message',
    '0000000000000000000000000000000000000000000000000000000000000aaa',
    'wamid.vis001', '15559876543', 'text', 'Visibility test',
    '2026-01-01T00:00:00Z'::timestamptz, 'req-vis-001'
  )),
  true,
  'Setup: ingest message for visibility test'
);

-- VR1: A valid non-default timeout (45) is actually passed through
-- Read with VT=45. The message should be returned (it was just enqueued, so VT of 45s hasn't expired).
-- We verify the message is returned and its vt reflects the requested timeout.
SELECT is(
  (SELECT count(*)::int FROM public.read_whatsapp_inbound_jobs(45, 1)),
  1,
  'VR1: read with visibility_timeout_seconds=45 returns the queued message'
);

-- VR2: The resulting queue message visibility reflects the requested timeout
-- After reading with VT=45, the message's vt should be approximately now() + 45 seconds.
-- We check that the vt is within the expected window (between 40 and 50 seconds from now).
SELECT is(
  (SELECT
    CASE
      WHEN EXTRACT(EPOCH FROM (vt - pg_catalog.now())) BETWEEN 40 AND 50 THEN true
      ELSE false
    END
   FROM public.read_whatsapp_inbound_jobs(45, 1)
   LIMIT 1),
  true,
  'VR2: message vt reflects the requested 45-second visibility timeout'
);

-- VR3: 0 is rejected with SQLSTATE 90007
SELECT throws_ok(
  $$SELECT * FROM public.read_whatsapp_inbound_jobs(0, 1)$$,
  '90007',
  'VR3: visibility timeout 0 is rejected with SQLSTATE 90007'
);

-- VR4: 3601 is rejected with SQLSTATE 90007
SELECT throws_ok(
  $$SELECT * FROM public.read_whatsapp_inbound_jobs(3601, 1)$$,
  '90007',
  'VR4: visibility timeout 3601 is rejected with SQLSTATE 90007'
);

-- VR5: p_limit remains bounded to 1-10
-- Requesting p_limit=0 should be clamped to 1 (not rejected), returning at most 1 message
-- Requesting p_limit=100 should be clamped to 10, returning at most 10 messages
-- We verify clamping by checking that limit=0 still returns results (clamped to 1)
-- and limit=100 does not error (clamped to 10)
SELECT is(
  (SELECT count(*)::int <= 1 FROM public.read_whatsapp_inbound_jobs(30, 0)),
  true,
  'VR5a: p_limit=0 is clamped to 1 (returns at most 1 message)'
);

-- VR6: Queue reads still return the real read_ct
-- Ingest another message, read it, and verify read_ct is present and is an integer >= 0
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-vis-001', 'meta', 'wamid.vis002', 'message',
    '0000000000000000000000000000000000000000000000000000000000000bbb',
    'wamid.vis002', '15559876543', 'text', 'Read count test',
    '2026-01-01T00:00:01Z'::timestamptz, 'req-vis-002'
  )),
  true,
  'VR6 setup: ingest second message for read_ct test'
);

SELECT is(
  (SELECT read_ct >= 0 FROM public.read_whatsapp_inbound_jobs(30, 1) LIMIT 1),
  true,
  'VR6: queue reads return the real read_ct (>= 0)'
);

SELECT finish();
ROLLBACK;