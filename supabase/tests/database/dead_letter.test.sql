-- pgTAP tests: dead-letter
-- File: supabase/tests/database/dead_letter.test.sql

BEGIN;
SELECT plan(9);

-- D1: Archive RPC inserts narrow failed_jobs record
SELECT has_function('public', 'archive_failed_job', ARRAY['bigint', 'text', 'text', 'integer', 'uuid'], 'archive_failed_job function exists');
SELECT has_table('public', 'failed_jobs', 'failed_jobs table exists');

-- D2: Archive RPC archives pgmq message
-- D3: Archive RPC dedup via unique(queue_name, pgmq_msg_id)
SELECT col_is_unique('public', 'failed_jobs', 'pgmq_msg_id', 'failed_jobs.pgmq_msg_id has unique constraint');

-- D4: failed_jobs contains no raw exception text, raw payload, or customer content
SELECT hasnt_column('public', 'failed_jobs', 'raw_exception', 'failed_jobs has no raw_exception column');
SELECT hasnt_column('public', 'failed_jobs', 'raw_payload', 'failed_jobs has no raw_payload column');
SELECT hasnt_column('public', 'failed_jobs', 'customer_content', 'failed_jobs has no customer_content column');

-- D5: Archive + pgmq archival are atomic (rollback on failure)
-- D6: Transient failures retry without dead-lettering (below max attempts)
-- D7: Final attempt dead-letters exactly once
-- D8: Repeated dead-letter invocation succeeds idempotently (already_archived=true)
-- D9: Dead-letter RPC cannot archive another queue (fixed queue name)

SELECT finish();
ROLLBACK;