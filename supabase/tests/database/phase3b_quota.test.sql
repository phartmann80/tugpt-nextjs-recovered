-- pgTAP tests: Phase 3B quota reserve/consume/release behavior
-- File: supabase/tests/database/phase3b_quota.test.sql

BEGIN;
SELECT plan(16);

-- =============================================================================
-- SETUP: Seed test data and ingest multiple messages
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3b-quota-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- Ingest 5 messages to have unique source_message_ids for different jobs
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.q001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.q001', '15559876543', 'text', 'Hello 1',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-q001'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q001')
);

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.q002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.q002', '15559876543', 'text', 'Hello 2',
  '2026-01-01T00:00:01Z'::timestamptz, 'req-q002'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q002')
);

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.q003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.q003', '15559876543', 'text', 'Hello 3',
  '2026-01-01T00:00:02Z'::timestamptz, 'req-q003'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q003')
);

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.q004', 'message',
  '0000000000000000000000000000000000000000000000000000000000000004',
  'wamid.q004', '15559876543', 'text', 'Hello 4',
  '2026-01-01T00:00:03Z'::timestamptz, 'req-q004'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q004')
);

SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-001', 'meta', 'wamid.q005', 'message',
  '0000000000000000000000000000000000000000000000000000000000000005',
  'wamid.q005', '15559876543', 'text', 'Hello 5',
  '2026-01-01T00:00:04Z'::timestamptz, 'req-q005'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q005')
);

-- Create a quota limit with ceiling of 3
INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 3);

-- Get message and conversation IDs
CREATE TEMP TABLE _q_msgs AS
SELECT
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q001')) AS msg1,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q002')) AS msg2,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q003')) AS msg3,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q004')) AS msg4,
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.q005')) AS msg5,
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = '11111111-1111-1111-1111-111111111111') AS conv_id;

-- Create job 1 (using msg1)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg1, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _q_msgs;

CREATE TEMP TABLE _q_job1 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg1 FROM _q_msgs);

-- Q1: Reserve succeeds for a new job
CREATE TEMP TABLE _q1_result AS
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job1));

SELECT is(
  (SELECT status FROM _q1_result),
  'NEWLY_RESERVED',
  'Q1: reserve_draft_usage returns NEWLY_RESERVED for new job'
);

-- Q2: Reserve again returns ALREADY_RESERVED
CREATE TEMP TABLE _q2_result AS
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job1));

SELECT is(
  (SELECT status FROM _q2_result),
  'ALREADY_RESERVED',
  'Q2: reserve_draft_usage returns ALREADY_RESERVED for existing reservation'
);

-- Q3: reserved_count is 1 after one reservation
SELECT is(
  (SELECT reserved_count FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Q3: reserved_count is 1 after one reservation'
);

-- Q4: Consume succeeds
SELECT is(
  private.consume_draft_reservation((SELECT id FROM _q_job1)),
  'CONSUMED',
  'Q4: consume_draft_reservation returns CONSUMED'
);

-- Q5: Consume again returns ALREADY_CONSUMED
SELECT is(
  private.consume_draft_reservation((SELECT id FROM _q_job1)),
  'ALREADY_CONSUMED',
  'Q5: consume_draft_reservation returns ALREADY_CONSUMED for already consumed'
);

-- Q6: draft_count is 1, reserved_count is 0 after consume
SELECT is(
  (SELECT draft_count FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Q6: draft_count is 1 after consume'
);

SELECT is(
  (SELECT reserved_count FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'Q6b: reserved_count is 0 after consume'
);

-- Q7: Release on consumed reservation returns ALREADY_CONSUMED
SELECT is(
  private.release_draft_reservation_internal((SELECT id FROM _q_job1)),
  'ALREADY_CONSUMED',
  'Q7: release on consumed returns ALREADY_CONSUMED'
);

-- Q8: Reserve with no active quota period returns DENIED / NO_ACTIVE_QUOTA_PERIOD
-- Create job 2 (using msg2)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg2, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _q_msgs;

CREATE TEMP TABLE _q_job2 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg2 FROM _q_msgs);

-- Delete quota data and create a period in the past
DELETE FROM public.draft_usage_reservations WHERE organization_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM public.draft_quota_limits WHERE organization_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE - INTERVAL '30 days', 3);

CREATE TEMP TABLE _q8_result AS
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job2));

SELECT is(
  (SELECT status FROM _q8_result),
  'DENIED',
  'Q8: reserve returns DENIED when no active quota period'
);

SELECT is(
  (SELECT reason FROM _q8_result),
  'NO_ACTIVE_QUOTA_PERIOD',
  'Q8b: reserve reason is NO_ACTIVE_QUOTA_PERIOD'
);

-- Q9: Reserve with quota exceeded returns DENIED / ENTITLEMENT_EXCEEDED
-- Create job 3 (using msg3)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg3, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _q_msgs;

CREATE TEMP TABLE _q_job3 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg3 FROM _q_msgs);

-- Create quota limit with ceiling 0
DELETE FROM public.draft_quota_limits WHERE organization_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('11111111-1111-1111-1111-111111111111', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 0);

CREATE TEMP TABLE _q9_result AS
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job3));

SELECT is(
  (SELECT status FROM _q9_result),
  'DENIED',
  'Q9: reserve returns DENIED when quota exceeded'
);

SELECT is(
  (SELECT reason FROM _q9_result),
  'ENTITLEMENT_EXCEEDED',
  'Q9b: reserve reason is ENTITLEMENT_EXCEEDED'
);

-- Q10: Release on job with no reservation returns NO_RESERVATION
-- Create job 4 (using msg4)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg4, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _q_msgs;

CREATE TEMP TABLE _q_job4 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg4 FROM _q_msgs);

-- Fix ceiling to allow reservations
UPDATE public.draft_quota_limits SET hard_ceiling = 5 WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  private.release_draft_reservation_internal((SELECT id FROM _q_job4)),
  'NO_RESERVATION',
  'Q10: release on job with no reservation returns NO_RESERVATION'
);

-- Q11: Release on non-existent job raises P3B07 DRAFT_JOB_NOT_FOUND
SELECT throws_ok(
  $$SELECT private.release_draft_reservation_internal('99999999-9999-9999-9999-999999999999')$$,
  'P3B07',
  'DRAFT_JOB_NOT_FOUND',
  'Q11: release on non-existent job raises P3B07'
);

-- Q12: Release with missing usage row raises P3B11
-- Create job 5 (using msg5)
INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', conv_id, msg5, '22222222-2222-2222-2222-222222222222', 'queued'
FROM _q_msgs;

CREATE TEMP TABLE _q_job5 AS
SELECT id FROM public.draft_generation_jobs WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND source_message_id = (SELECT msg5 FROM _q_msgs);

SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job5));

-- Delete the usage tracking row to simulate corruption
DELETE FROM public.draft_usage_tracking WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT throws_ok(
  $$SELECT private.release_draft_reservation_internal((SELECT id FROM _q_job5))$$,
  'P3B11',
  'QUOTA_RESERVATION_STATE_ERROR',
  'Q12: release with missing usage row raises P3B11'
);

-- Q13: Release with zero reserved_count raises P3B11
-- Re-create usage tracking and reserve a new job
-- Use job4 which has no reservation yet
SELECT * FROM private.reserve_draft_usage((SELECT id FROM _q_job4));

-- Set reserved_count to 0 to simulate inconsistency
UPDATE public.draft_usage_tracking SET reserved_count = 0 WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT throws_ok(
  $$SELECT private.release_draft_reservation_internal((SELECT id FROM _q_job4))$$,
  'P3B11',
  'QUOTA_RESERVATION_STATE_ERROR',
  'Q13: release with zero reserved_count raises P3B11'
);

SELECT finish();
ROLLBACK;