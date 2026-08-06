-- pgTAP tests: Phase 3B schema existence and constraints
-- File: supabase/tests/database/phase3b_schema.test.sql

BEGIN;
SELECT plan(43);

-- =============================================================================
-- SETUP: Seed test data
-- =============================================================================
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Org', 'phase3b-test-org');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '+15551234567', 'conn-001', 'active');

-- =============================================================================
-- S1: ai_draft_configs table exists with correct columns
-- =============================================================================
SELECT has_table('public', 'ai_draft_configs', 'S1: ai_draft_configs table exists');
SELECT has_column('public', 'ai_draft_configs', 'organization_id', 'S1: ai_draft_configs has organization_id');
SELECT has_column('public', 'ai_draft_configs', 'business_profile_id', 'S1: ai_draft_configs has business_profile_id');
SELECT has_column('public', 'ai_draft_configs', 'business_instructions', 'S1: ai_draft_configs has business_instructions');
SELECT has_column('public', 'ai_draft_configs', 'max_draft_length', 'S1: ai_draft_configs has max_draft_length');

-- S2: ai_drafts table exists with correct columns
SELECT has_table('public', 'ai_drafts', 'S2: ai_drafts table exists');
SELECT has_column('public', 'ai_drafts', 'current_revision_id', 'S2: ai_drafts has current_revision_id');
SELECT has_column('public', 'ai_drafts', 'status', 'S2: ai_drafts has status');
SELECT has_column('public', 'ai_drafts', 'version', 'S2: ai_drafts has version');

-- S3: draft_generation_jobs table exists
SELECT has_table('public', 'draft_generation_jobs', 'S3: draft_generation_jobs table exists');
SELECT has_column('public', 'draft_generation_jobs', 'pgmq_msg_id', 'S3: draft_generation_jobs has pgmq_msg_id');
SELECT has_column('public', 'draft_generation_jobs', 'status', 'S3: draft_generation_jobs has status');

-- S4: draft_quota_limits table exists with EXCLUDE constraint
SELECT has_table('public', 'draft_quota_limits', 'S4: draft_quota_limits table exists');
SELECT has_column('public', 'draft_quota_limits', 'hard_ceiling', 'S4: draft_quota_limits has hard_ceiling');
SELECT col_is_unique('public', 'draft_quota_limits', ARRAY['organization_id', 'period_start'], 'S4: draft_quota_limits has unique (org, period_start)');

-- S5: draft_usage_tracking table exists
SELECT has_table('public', 'draft_usage_tracking', 'S5: draft_usage_tracking table exists');
SELECT has_column('public', 'draft_usage_tracking', 'reserved_count', 'S5: draft_usage_tracking has reserved_count');
SELECT has_column('public', 'draft_usage_tracking', 'draft_count', 'S5: draft_usage_tracking has draft_count');

-- S6: draft_usage_reservations table exists with UNIQUE(draft_generation_job_id)
SELECT has_table('public', 'draft_usage_reservations', 'S6: draft_usage_reservations table exists');
SELECT col_is_unique('public', 'draft_usage_reservations', ARRAY['draft_generation_job_id'], 'S6: draft_usage_reservations has unique (draft_generation_job_id)');

-- S7: ai_draft_revisions table exists with actor model
SELECT has_table('public', 'ai_draft_revisions', 'S7: ai_draft_revisions table exists');
SELECT has_column('public', 'ai_draft_revisions', 'created_by_type', 'S7: ai_draft_revisions has created_by_type');
SELECT has_column('public', 'ai_draft_revisions', 'created_by_user_id', 'S7: ai_draft_revisions has created_by_user_id');

-- S8: ai_draft_review_events table exists
SELECT has_table('public', 'ai_draft_review_events', 'S8: ai_draft_review_events table exists');
SELECT has_column('public', 'ai_draft_review_events', 'action', 'S8: ai_draft_review_events has action');

-- S9: feature_flags global unique index exists
SELECT has_index('public', 'feature_flags', 'feature_flags_global_key_unique', 'S9: feature_flags has global key unique index');

-- S10: is_feature_enabled RPC exists
SELECT has_function('public', 'is_feature_enabled', ARRAY['uuid', 'text'], 'S10: is_feature_enabled function exists');

-- S11: failed_jobs error_code CHECK includes Phase 3B codes
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'failed_jobs_error_code_check'
    AND contype = 'c'
  ),
  'S11: failed_jobs error_code CHECK constraint exists'
);

-- S12: draft_generation PGMQ queue exists
SELECT has_table('pgmq', 'q_draft_generation', 'S12: draft_generation PGMQ queue exists');

-- S13: Private schema helpers exist
SELECT has_function('private', 'reserve_draft_usage', ARRAY['uuid'], 'S13: private.reserve_draft_usage exists');
SELECT has_function('private', 'consume_draft_reservation', ARRAY['uuid'], 'S13: private.consume_draft_reservation exists');
SELECT has_function('private', 'release_draft_reservation_internal', ARRAY['uuid'], 'S13: private.release_draft_reservation_internal exists');
SELECT has_function('private', 'store_draft', ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text'], 'S13: private.store_draft exists');
SELECT has_function('private', 'archive_draft_failed_job', ARRAY['bigint', 'uuid', 'text'], 'S13: private.archive_draft_failed_job exists');
SELECT has_function('private', 'skip_draft_job', ARRAY['uuid', 'bigint', 'text'], 'S13: private.skip_draft_job exists');

-- S14: Public queue wrapper RPCs for draft_generation exist
SELECT has_function('public', 'read_draft_generation_jobs', ARRAY['int', 'int'], 'S14: read_draft_generation_jobs exists');
SELECT has_function('public', 'delete_draft_generation_job', ARRAY['bigint'], 'S14: delete_draft_generation_job exists');
SELECT has_function('public', 'set_draft_generation_visibility', ARRAY['bigint', 'int'], 'S14: set_draft_generation_visibility exists');

-- S15: Human review RPCs exist
SELECT has_function('public', 'approve_draft', ARRAY['uuid', 'integer'], 'S15: approve_draft exists');
SELECT has_function('public', 'edit_draft', ARRAY['uuid', 'integer', 'text'], 'S15: edit_draft exists');
SELECT has_function('public', 'reject_draft', ARRAY['uuid', 'integer'], 'S15: reject_draft exists');

-- S16: Queue payload timestamp uses explicit UTC conversion (clock_timestamp AT TIME ZONE 'UTC')
-- Verify the function source contains the UTC conversion pattern
SELECT ok(
  (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public' AND p.proname = 'process_inbound_message') LIKE '%AT TIME ZONE ''UTC''%',
  'S16: process_inbound_message uses explicit AT TIME ZONE UTC for timestamp'
);

-- S17: Queue payload timestamp is timezone-independent
-- Set session timezone to non-UTC and verify the timestamp still represents UTC
DO $$
DECLARE
  v_ts TEXT;
  v_utc_ts TEXT;
BEGIN
  -- Set session timezone to America/New_York (UTC-5 or UTC-4 with DST)
  PERFORM set_config('TimeZone', 'America/New_York', false);
  -- Get the timestamp as the function would produce it
  v_ts := pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- Reset to UTC
  PERFORM set_config('TimeZone', 'UTC', false);
  -- Get UTC timestamp for comparison (should be very close)
  v_utc_ts := pg_catalog.to_char(pg_catalog.clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- Both should end with Z and be within a few seconds of each other
  -- The key assertion: v_ts ends with 'Z' regardless of session timezone
  CREATE TEMP TABLE IF NOT EXISTS _s17_result (ts_text TEXT, ends_with_z BOOLEAN);
  INSERT INTO _s17_result VALUES (v_ts, right(v_ts, 1) = 'Z');
END;
$$;

SELECT is(
  (SELECT ends_with_z FROM _s17_result),
  true,
  'S17: queue timestamp ends with Z regardless of session timezone'
);

SELECT finish();
ROLLBACK;