-- transcript_ingest.test.sql
--
-- The path a voice note takes from a webhook to a draft (migration
-- 20260903000008).
--
-- WHAT THIS FILE IS ACTUALLY DEFENDING. Three things, in descending order of
-- how expensive they are to get wrong:
--
--   1. Money. A transcription job is a billable call. The enqueue is gated on
--      five conditions and a duplicate costs real money for one voice note, so
--      T1-T8 test each gate independently against a positive control rather
--      than testing "the happy path works" and trusting the ANDs.
--
--   2. Provenance. A reviewer approving a draft written from a machine's guess
--      at a customer's words must be able to see that is what happened. S1-S5
--      pin that `body_source` cannot be absent where a body exists, cannot be
--      invented where one does not, and cannot hold a value nobody defined.
--
--   3. Atomicity. `complete_transcription_job` writes a transcript, completes
--      a job and enqueues a draft. C1-C4 assert all three landed from one
--      call, because the failure mode of splitting them is a message with a
--      body nobody drafts from -- silent, and invisible until a customer is
--      ignored.
--
-- ON THE FIXTURE TRAP. Three times in this stack a test has passed while
-- quietly testing nothing, because its fixture stopped satisfying an unrelated
-- precondition (a price window, a subscription period) and the code under test
-- was skipped for a reason the assertion could not see. The defence used here
-- is the one that keeps working: every negative assertion is paired with a
-- positive control run against the same fixture, so "no job was created" can
-- never be confused with "no job would have been created anyway".
--
-- ONE MUTATION SURVIVES, RECORDED RATHER THAN PAPERED OVER. Replacing the
-- `EXCEPTION WHEN unique_violation` handler around the transcription enqueue
-- with one that catches nothing escapes all 52 assertions. It escapes because
-- the handler is unreachable from a cold database: `process_inbound_message`
-- returns early on an already-processed receipt, so reaching a second enqueue
-- for one message requires a receipt that is not yet marked processed while
-- its message row already exists -- a state only a crash between two
-- statements can produce. Reproducing it would mean killing a backend
-- mid-function. The handler stays, because the constraint behind it (T12) is
-- what actually stops the double charge and the handler only decides whether
-- the second delivery errors or shrugs; but this is a guard whose behaviour
-- no test here observes, and saying so is better than implying otherwise.
--
-- NOT HERE: the backfill. `body_source = 'customer'` for every pre-existing
-- body is an exact statement about a database with history, and a cold build
-- has none. The invariant it establishes -- no body without a source -- is now
-- a CHECK, and S1 tests the CHECK. Asserting the UPDATE touched zero rows on
-- an empty table would be a test that passes if the UPDATE is deleted.

BEGIN;
SELECT plan(52);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7a11-0000-0000-000000000001', 'Clínica Transcripción', 'transcript-ingest-test');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('bbbbbbbb-7a11-0000-0000-000000000001', 'aaaaaaaa-7a11-0000-0000-000000000001', 'Recepción');

INSERT INTO public.whatsapp_connections (
  id, organization_id, business_profile_id, phone_number,
  provider_phone_number_id, status
) VALUES (
  'cccccccc-7a11-0000-0000-000000000001', 'aaaaaaaa-7a11-0000-0000-000000000001',
  'bbbbbbbb-7a11-0000-0000-000000000001', '+34600000001', 'conn-transcript', 'active'
);

-- Both flags on for this organization, both master switches on. Every gate
-- test below turns exactly one of these off and turns it back on again, so a
-- gate that stopped working would be caught by the control rather than
-- rewarded by it.
UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id IS NULL AND key IN ('voice_transcription', 'ai_draft_generation');

INSERT INTO public.feature_flags (organization_id, key, is_enabled) VALUES
  ('aaaaaaaa-7a11-0000-0000-000000000001', 'voice_transcription', true);

-- Through the production helper rather than an INSERT, because a bare INSERT
-- is refused: 20260826000001 requires a draft quota period to exist before
-- `ai_draft_generation` can be enabled for an organization, so that enabling
-- the flag cannot produce an org whose every job is denied for want of a
-- period. Using the helper means this fixture is the state an operator would
-- actually create.
SELECT public.enable_draft_generation_for_org(
  'aaaaaaaa-7a11-0000-0000-000000000001', 1000);

-- One helper, because the ingest+process pair is nine lines of noise repeated
-- a dozen times below and the thing under test is the two arguments that vary.
CREATE FUNCTION pg_temp.deliver(
  p_key TEXT,
  p_kind TEXT,
  p_body TEXT,
  p_media TEXT DEFAULT NULL,
  p_mime TEXT DEFAULT NULL,
  p_contact TEXT DEFAULT '34600999001'
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id UUID;
  v_message_id UUID;
BEGIN
  SELECT webhook_event_id INTO v_event_id
  FROM public.ingest_whatsapp_message_event(
    'conn-transcript', 'meta', p_key, 'message',
    pg_catalog.encode(pg_catalog.sha256(p_key::bytea), 'hex'),
    p_key, p_contact, p_kind, p_body,
    '2026-09-03T10:00:00Z'::timestamptz, 'req-' || p_key,
    p_media, p_mime
  );

  SELECT message_id INTO v_message_id
  FROM public.process_inbound_message(v_event_id);

  RETURN v_message_id;
END;
$$;

-- ===========================================================================
-- I: ingest carries the media reference, and still works without one
-- ===========================================================================

-- The eleven-argument call, unchanged. The migration claims the new parameters
-- are defaulted so that the database can deploy before the web app does; this
-- is that claim, and it is the difference between a deployable migration and
-- one that requires two systems to ship in the same second.
SELECT is(
  (SELECT is_new FROM public.ingest_whatsapp_message_event(
    'conn-transcript', 'meta', 'wamid.i1', 'message',
    pg_catalog.encode(pg_catalog.sha256('wamid.i1'::bytea), 'hex'),
    'wamid.i1', '34600999002', 'text', 'Hola',
    '2026-09-03T09:00:00Z'::timestamptz, 'req-i1'
  )),
  true,
  'I1: the pre-existing 11-argument signature still resolves and still works'
);

SELECT is(
  (SELECT media_reference FROM public.inbound_message_staging s
    JOIN public.webhook_events e ON e.id = s.webhook_event_id
    WHERE e.provider_event_key = 'wamid.i1'),
  NULL,
  'I2: an 11-argument call stages a NULL media reference rather than failing'
);

SELECT is(
  (SELECT webhook_event_id IS NOT NULL FROM public.ingest_whatsapp_message_event(
    'conn-transcript', 'meta', 'wamid.i3', 'message',
    pg_catalog.encode(pg_catalog.sha256('wamid.i3'::bytea), 'hex'),
    'wamid.i3', '34600999002', 'audio', NULL,
    '2026-09-03T09:01:00Z'::timestamptz, 'req-i3',
    'media-i3', 'audio/ogg; codecs=opus'
  )),
  true,
  'I3: the 13-argument call is accepted'
);

SELECT results_eq(
  $$SELECT s.media_reference, s.media_mime_type
    FROM public.inbound_message_staging s
    JOIN public.webhook_events e ON e.id = s.webhook_event_id
    WHERE e.provider_event_key = 'wamid.i3'$$,
  $$VALUES ('media-i3'::text, 'audio/ogg; codecs=opus'::text)$$,
  'I4: staging holds the media reference and its mime type'
);

-- ===========================================================================
-- M: processing records what kind it was
-- ===========================================================================

-- A text message, which is the shape every existing row has.
CREATE TEMP TABLE _m_text AS SELECT pg_temp.deliver('wamid.m1', 'text', 'Buenos días') AS id;

SELECT results_eq(
  $$SELECT kind, body_source, media_reference FROM public.messages
    WHERE id = (SELECT id FROM _m_text)$$,
  $$VALUES ('text'::text, 'customer'::text, NULL::text)$$,
  'M1: a typed message records kind=text and body_source=customer'
);

-- A voice note, which is the shape that did not previously survive processing.
CREATE TEMP TABLE _m_audio AS
  SELECT pg_temp.deliver('wamid.m2', 'audio', NULL, 'media-m2', 'audio/ogg') AS id;

SELECT results_eq(
  $$SELECT kind, body, body_source, media_reference, media_mime_type
    FROM public.messages WHERE id = (SELECT id FROM _m_audio)$$,
  $$VALUES ('audio'::text, NULL::text, NULL::text, 'media-m2'::text, 'audio/ogg'::text)$$,
  'M2: a voice note survives processing with its media reference and no invented body'
);

-- ===========================================================================
-- S: a body always says where it came from
-- ===========================================================================
--
-- Deliberately placed AFTER the fixtures above, and not for tidiness. Written
-- first, every assertion in this section passed while testing nothing: with no
-- conversation and no message yet in existence, `INSERT ... SELECT ... FROM
-- public.conversations` inserted zero rows and `UPDATE public.messages`
-- updated zero rows, so no CHECK was ever reached and four `throws_ok` calls
-- were asserting against statements that could not throw. That is the fourth
-- time in this stack a test has quietly stopped testing its subject because a
-- fixture was not there yet; the rule that keeps catching it is that anything
-- expecting a constraint to fire must name the row it fires on.

-- Two unprocessed receipts, because `messages.webhook_event_id` is NOT NULL
-- and UNIQUE: a hand-built message row needs a receipt of its own, and reusing
-- an existing one would fail on the unique constraint instead of the CHECK.
CREATE TEMP TABLE _s_receipts AS
SELECT
  (SELECT webhook_event_id FROM public.ingest_whatsapp_message_event(
    'conn-transcript', 'meta', 'wamid.s1', 'message',
    pg_catalog.encode(pg_catalog.sha256('wamid.s1'::bytea), 'hex'),
    'wamid.s1', '34600999003', 'text', 'x',
    '2026-09-03T09:30:00Z'::timestamptz, 'req-s1')) AS r1,
  (SELECT webhook_event_id FROM public.ingest_whatsapp_message_event(
    'conn-transcript', 'meta', 'wamid.s2', 'message',
    pg_catalog.encode(pg_catalog.sha256('wamid.s2'::bytea), 'hex'),
    'wamid.s2', '34600999003', 'text', 'x',
    '2026-09-03T09:31:00Z'::timestamptz, 'req-s2')) AS r2,
  (SELECT conversation_id FROM public.messages WHERE id = (SELECT id FROM _m_text)) AS conv;

SELECT throws_ok(
  format($$INSERT INTO public.messages (
      conversation_id, organization_id, webhook_event_id, direction,
      provider_message_id, body, status
    ) VALUES (%L::uuid, %L::uuid, %L::uuid, 'inbound', 'wamid.s1', 'palabras', 'received')$$,
    (SELECT conv FROM _s_receipts),
    'aaaaaaaa-7a11-0000-0000-000000000001',
    (SELECT r1 FROM _s_receipts)),
  '23514',
  NULL,
  'S1: a body with no body_source is refused'
);

-- The other direction, and not a formality: a one-way check would let a
-- transcript row exist with no words in it, which reads to a reviewer as a
-- customer who said nothing rather than as a job that produced nothing.
SELECT throws_ok(
  format($$INSERT INTO public.messages (
      conversation_id, organization_id, webhook_event_id, direction,
      provider_message_id, body, body_source, status
    ) VALUES (%L::uuid, %L::uuid, %L::uuid, 'inbound', 'wamid.s2', NULL, 'customer', 'received')$$,
    (SELECT conv FROM _s_receipts),
    'aaaaaaaa-7a11-0000-0000-000000000001',
    (SELECT r2 FROM _s_receipts)),
  '23514',
  NULL,
  'S2: a body_source with no body is refused'
);

-- The positive control for S1 and S2: the same row shape with both halves
-- present is accepted. Without it, both could be passing because the row was
-- malformed in some way neither assertion names.
SELECT lives_ok(
  format($$INSERT INTO public.messages (
      conversation_id, organization_id, webhook_event_id, direction,
      provider_message_id, body, body_source, status
    ) VALUES (%L::uuid, %L::uuid, %L::uuid, 'inbound', 'wamid.s2', 'palabras', 'customer', 'received')$$,
    (SELECT conv FROM _s_receipts),
    'aaaaaaaa-7a11-0000-0000-000000000001',
    (SELECT r2 FROM _s_receipts)),
  'S2b: body and body_source together are accepted, so S1-S2 are real'
);

SELECT col_is_null('public', 'messages', 'kind',
  'S3: kind is nullable, because rows recorded before this migration have none');

SELECT throws_ok(
  format($$UPDATE public.messages SET kind = 'sticker' WHERE id = %L::uuid$$,
    (SELECT id FROM _m_text)),
  '23514',
  NULL,
  'S4: kind is restricted to the kinds the ingest path validates'
);

SELECT throws_ok(
  format($$UPDATE public.messages SET body_source = 'guessed' WHERE id = %L::uuid$$,
    (SELECT id FROM _m_text)),
  '23514',
  NULL,
  'S5: body_source is restricted to customer and machine_transcript'
);

-- The positive control for S4 and S5 together. Both are `throws_ok` against a
-- row that must exist for them to mean anything; this asserts it does, and
-- that an allowed value on the same column of the same row succeeds.
SELECT lives_ok(
  format($$UPDATE public.messages SET kind = 'document' WHERE id = %L::uuid$$,
    (SELECT id FROM _m_text)),
  'S6: a supported kind on that same row is accepted, so S4-S5 are real'
);

UPDATE public.messages SET kind = 'text' WHERE id = (SELECT id FROM _m_text);

-- ===========================================================================
-- T: the enqueue gates, each one alone
-- ===========================================================================

-- T1 is the positive control the whole section depends on. If it ever fails,
-- every T2-T7 "no job was created" below is meaningless, so it runs first.
SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_audio)),
  1,
  'T1: an audio message with both flags on and a media reference is enqueued'
);

SELECT results_eq(
  $$SELECT status, media_reference, media_mime_type, attempts, pgmq_msg_id IS NOT NULL
    FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_audio)$$,
  $$VALUES ('queued'::text, 'media-m2'::text, 'audio/ogg'::text, 0, true)$$,
  'T2: the job is queued, carries what the worker needs, and has a queue message'
);

SELECT is(
  (SELECT count(*)::int FROM pgmq.q_transcription
    WHERE (message->>'transcriptionJobId')::uuid =
      (SELECT id FROM public.transcription_jobs
        WHERE source_message_id = (SELECT id FROM _m_audio))),
  1,
  'T3: the queue holds exactly one message naming that job'
);

-- A text message pays for no transcription. This is also the assertion that
-- keeps the draft path and the transcription path from colliding: a typed
-- message must take the draft branch and only the draft branch.
SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_text)),
  0,
  'T4: a typed message enqueues no transcription'
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE source_message_id = (SELECT id FROM _m_text)),
  1,
  'T5: ...and does still enqueue a draft, so T4 is a real observation'
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE source_message_id = (SELECT id FROM _m_audio)),
  0,
  'T6: a voice note enqueues no draft before it has a transcript'
);

-- T6b isolates the KIND gate, which T4 does not. A text message carries no
-- media reference, so `message_kind = 'audio'` and `media_reference IS NOT
-- NULL` both stop it and T4 cannot say which one did -- mutating the kind
-- check to `message_kind IS NOT NULL` survived the whole suite until this was
-- added. An image with a media reference passes the media gate and must still
-- be refused, which only the kind gate can do.
CREATE TEMP TABLE _m_image AS
  SELECT pg_temp.deliver('wamid.m8', 'image', NULL, 'media-m8', 'image/jpeg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_image)),
  0,
  'T6b: an image with a media reference is not sent to a speech transcriber'
);

SELECT is(
  (SELECT media_reference FROM public.messages WHERE id = (SELECT id FROM _m_image)),
  'media-m8',
  'T6c: ...and it really did carry one, so T6b tests the kind and not the media'
);

-- Gate: no media reference. Older deliveries carry none and a job pointing at
-- nothing would burn its retries and dead-letter.
CREATE TEMP TABLE _m_nomedia AS
  SELECT pg_temp.deliver('wamid.m3', 'audio', NULL, NULL, 'audio/ogg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_nomedia)),
  0,
  'T7: an audio message with no media reference enqueues nothing to fetch'
);

-- Gate: the spend flag.
UPDATE public.feature_flags SET is_enabled = false
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'voice_transcription';

CREATE TEMP TABLE _m_flagoff AS
  SELECT pg_temp.deliver('wamid.m4', 'audio', NULL, 'media-m4', 'audio/ogg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_flagoff)),
  0,
  'T8: voice_transcription off spends nothing'
);

UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'voice_transcription';

-- Gate: the draft flag. Transcribing for an organization that cannot draft is
-- paying Gladia to produce a row no reviewer will ever see.
UPDATE public.feature_flags SET is_enabled = false
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'ai_draft_generation';

CREATE TEMP TABLE _m_draftoff AS
  SELECT pg_temp.deliver('wamid.m5', 'audio', NULL, 'media-m5', 'audio/ogg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_draftoff)),
  0,
  'T9: ai_draft_generation off transcribes nothing, because nobody would read it'
);

UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'ai_draft_generation';

-- Gate: conversation status. A closed conversation is one a human ended.
UPDATE public.conversations SET status = 'closed'
WHERE contact_phone = '34600999001';

CREATE TEMP TABLE _m_closed AS
  SELECT pg_temp.deliver('wamid.m6', 'audio', NULL, 'media-m6', 'audio/ogg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_closed)),
  0,
  'T10: a closed conversation transcribes nothing'
);

UPDATE public.conversations SET status = 'open'
WHERE contact_phone = '34600999001';

-- The positive control for T7-T10 together: the same fixture, all four gates
-- restored, still enqueues. Without this, all four could be passing because
-- the fixture drifted into some unrelated failure -- which is exactly how
-- three tests in this stack came to be silently vacuous.
CREATE TEMP TABLE _m_control AS
  SELECT pg_temp.deliver('wamid.m7', 'audio', NULL, 'media-m7', 'audio/ogg') AS id;

SELECT is(
  (SELECT count(*)::int FROM public.transcription_jobs
    WHERE source_message_id = (SELECT id FROM _m_control)),
  1,
  'T11: with every gate restored the same fixture enqueues, so T7-T10 are real'
);

-- One transcription per message, enforced rather than hoped for. Gladia bills
-- on submission, so a second job for one voice note is a second charge.
SELECT throws_ok(
  $$INSERT INTO public.transcription_jobs (
      organization_id, conversation_id, source_message_id, media_reference, status
    )
    SELECT organization_id, conversation_id, id, 'media-dup', 'queued'
    FROM public.messages WHERE id = (SELECT id FROM _m_audio)$$,
  '23505',
  NULL,
  'T12: a second transcription job for the same message is refused'
);

-- ===========================================================================
-- C: completing a transcription does three things at once
-- ===========================================================================

CREATE TEMP TABLE _c_job AS
  SELECT id FROM public.transcription_jobs
  WHERE source_message_id = (SELECT id FROM _m_audio);

CREATE TEMP TABLE _c_result AS
  SELECT * FROM private.complete_transcription_job(
    (SELECT id FROM _c_job), 'Quería pedir cita para el martes', 'gladia',
    'gladia-job-c1', 'es'
  );

SELECT results_eq(
  $$SELECT body, body_source FROM public.messages
    WHERE id = (SELECT id FROM _m_audio)$$,
  $$VALUES ('Quería pedir cita para el martes'::text, 'machine_transcript'::text)$$,
  'C1: the transcript lands on the message, marked as a machine transcript'
);

SELECT results_eq(
  $$SELECT status, provider, provider_job_reference, language_code
    FROM public.transcription_jobs WHERE id = (SELECT id FROM _c_job)$$,
  $$VALUES ('completed'::text, 'gladia'::text, 'gladia-job-c1'::text, 'es'::text)$$,
  'C2: the job completes and records the provider, its handle and the language'
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE source_message_id = (SELECT id FROM _m_audio)),
  1,
  'C3: the transcribed message is handed to the draft path'
);

SELECT results_eq(
  $$SELECT message_id, draft_enqueued FROM _c_result$$,
  $$SELECT id, true FROM _m_audio$$,
  'C4: the call reports which message it wrote and that a draft was enqueued'
);

-- The silent voice note. Billed, correctly reported as empty by the adapter,
-- and decided here.
CREATE TEMP TABLE _c_empty_job AS
  SELECT id FROM public.transcription_jobs
  WHERE source_message_id = (SELECT id FROM _m_control);

CREATE TEMP TABLE _c_empty AS
  SELECT * FROM private.complete_transcription_job(
    (SELECT id FROM _c_empty_job), '   ', 'gladia', 'gladia-job-c5', NULL
  );

SELECT is(
  (SELECT status FROM public.transcription_jobs WHERE id = (SELECT id FROM _c_empty_job)),
  'completed',
  'C5: an empty transcript still completes the job, because it was still billed'
);

SELECT results_eq(
  $$SELECT body, body_source FROM public.messages
    WHERE id = (SELECT id FROM _m_control)$$,
  $$VALUES (NULL::text, NULL::text)$$,
  'C6: an empty transcript writes no body, so no reviewer sees an empty message'
);

SELECT results_eq(
  $$SELECT draft_enqueued FROM _c_empty$$,
  $$VALUES (false)$$,
  'C7: an empty transcript enqueues no draft'
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE source_message_id = (SELECT id FROM _m_control)),
  0,
  'C8: ...and none exists, so C7 is not merely a return value'
);

SELECT throws_ok(
  $$SELECT * FROM private.complete_transcription_job(
      '00000000-7a11-0000-0000-0000000000ff', 'x', 'gladia')$$,
  'P3I01',
  'TRANSCRIPTION_JOB_NOT_FOUND',
  'C9: completing an unknown job raises P3I01'
);

-- A redelivered queue message must not overwrite a transcript a reviewer may
-- already have edited a draft from.
SELECT throws_ok(
  format($$SELECT * FROM private.complete_transcription_job(
      %L::uuid, 'otra transcripción', 'gladia')$$, (SELECT id FROM _c_job)),
  'P3I02',
  'TRANSCRIPTION_JOB_ALREADY_TERMINAL',
  'C10: completing an already-completed job raises P3I02'
);

SELECT is(
  (SELECT body FROM public.messages WHERE id = (SELECT id FROM _m_audio)),
  'Quería pedir cita para el martes',
  'C11: ...and the first transcript is still the one on the message'
);

-- Transcription is paid for whether or not drafting is on, so the transcript
-- is recorded either way; only the draft is skipped.
UPDATE public.feature_flags SET is_enabled = false
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'ai_draft_generation';

CREATE TEMP TABLE _c_nodraft_msg AS
  SELECT id FROM public.messages WHERE provider_message_id = 'wamid.m4';

INSERT INTO public.transcription_jobs (
  organization_id, conversation_id, source_message_id, media_reference, status
)
SELECT organization_id, conversation_id, id, 'media-m4', 'queued'
FROM public.messages WHERE id = (SELECT id FROM _c_nodraft_msg);

CREATE TEMP TABLE _c_nodraft AS
  SELECT * FROM private.complete_transcription_job(
    (SELECT id FROM public.transcription_jobs
      WHERE source_message_id = (SELECT id FROM _c_nodraft_msg)),
    'Llamo por el pedido', 'gladia'
  );

SELECT results_eq(
  $$SELECT body, body_source FROM public.messages
    WHERE id = (SELECT id FROM _c_nodraft_msg)$$,
  $$VALUES ('Llamo por el pedido'::text, 'machine_transcript'::text)$$,
  'C12: a transcript is recorded even when drafting is off -- it was paid for'
);

SELECT results_eq(
  $$SELECT draft_enqueued FROM _c_nodraft$$,
  $$VALUES (false)$$,
  'C13: ...but no draft is enqueued'
);

UPDATE public.feature_flags SET is_enabled = true
WHERE organization_id = 'aaaaaaaa-7a11-0000-0000-000000000001'
  AND key = 'ai_draft_generation';

-- ===========================================================================
-- F: failure never invents a body
-- ===========================================================================

CREATE TEMP TABLE _f_msg AS
  SELECT pg_temp.deliver('wamid.f1', 'audio', NULL, 'media-f1', 'audio/ogg') AS id;

CREATE TEMP TABLE _f_job AS
  SELECT id FROM public.transcription_jobs
  WHERE source_message_id = (SELECT id FROM _f_msg);

SELECT lives_ok(
  format($$SELECT private.fail_transcription_job(%L::uuid, 'PROVIDER_TIMEOUT')$$,
    (SELECT id FROM _f_job)),
  'F1: a retryable failure is accepted'
);

SELECT results_eq(
  $$SELECT status, attempts, error_code FROM public.transcription_jobs
    WHERE id = (SELECT id FROM _f_job)$$,
  $$VALUES ('queued'::text, 1, 'PROVIDER_TIMEOUT'::text)$$,
  'F2: a retryable failure counts the attempt and leaves the job claimable'
);

SELECT results_eq(
  $$SELECT body, body_source FROM public.messages WHERE id = (SELECT id FROM _f_msg)$$,
  $$VALUES (NULL::text, NULL::text)$$,
  'F3: failure writes no diagnostics into the body a reviewer reads'
);

SELECT lives_ok(
  format($$SELECT private.fail_transcription_job(%L::uuid, 'MALFORMED_PROVIDER_RESPONSE', true)$$,
    (SELECT id FROM _f_job)),
  'F4: a terminal failure is accepted'
);

SELECT results_eq(
  $$SELECT status, attempts FROM public.transcription_jobs
    WHERE id = (SELECT id FROM _f_job)$$,
  $$VALUES ('dead_lettered'::text, 2)$$,
  'F5: dead-lettering is terminal and keeps the attempt count'
);

SELECT throws_ok(
  format($$SELECT private.fail_transcription_job(%L::uuid, 'AGAIN')$$,
    (SELECT id FROM _f_job)),
  'P3I02',
  'TRANSCRIPTION_JOB_ALREADY_TERMINAL',
  'F6: a dead-lettered job cannot be failed again'
);

-- A dead-lettered job must not be completable either, or a late provider
-- callback would revive one the operator has already written off.
SELECT throws_ok(
  format($$SELECT * FROM private.complete_transcription_job(%L::uuid, 'tarde', 'gladia')$$,
    (SELECT id FROM _f_job)),
  'P3I02',
  'TRANSCRIPTION_JOB_ALREADY_TERMINAL',
  'F7: a dead-lettered job cannot be completed by a late callback'
);

-- ===========================================================================
-- P: nobody with a browser session can reach any of this
-- ===========================================================================

SELECT table_privs_are('public', 'transcription_jobs', 'authenticated', ARRAY[]::text[],
  'P1: authenticated has no privileges on transcription_jobs');
SELECT table_privs_are('public', 'transcription_jobs', 'anon', ARRAY[]::text[],
  'P2: anon has no privileges on transcription_jobs');

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
     FROM pg_catalog.pg_class
    WHERE oid = 'public.transcription_jobs'::regclass),
  'P3: RLS is enabled and forced on transcription_jobs'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege('authenticated',
    'private.complete_transcription_job(uuid,text,text,text,text)', 'EXECUTE'),
  'P4: authenticated cannot execute complete_transcription_job'
);

SELECT ok(
  pg_catalog.has_function_privilege('service_role',
    'private.complete_transcription_job(uuid,text,text,text,text)', 'EXECUTE'),
  'P5: service_role can, so P4 is a restriction rather than an absence'
);

SELECT * FROM finish();
ROLLBACK;
