-- conversation_activity_ordering.test.sql
--
-- `conversations.activity_at` — the ordering key the unified inbox reads.
--
-- The defect this column exists for is not that ordering by `last_message_at`
-- looks untidy. It is that `last_message_at` is nullable, DESC implies NULLS
-- FIRST, and the one producer of that column copies a nullable, unvalidated
-- `provider_timestamp` straight into it. A webhook the system could not read a
-- timestamp out of therefore produces the permanent top row of every
-- reviewer's inbox.
--
-- So A3 and A4 below are the tests that matter: they assert the ordering
-- against a row with a NULL `last_message_at`, which is the only case where
-- the old expression and the new one disagree. A suite that only used rows
-- with timestamps would pass identically before and after this migration.

BEGIN;
SELECT plan(17);

-- --- Fixtures --------------------------------------------------------------
-- Written with the service role so RLS is not in the way; this file is about
-- the column's semantics, not about who may read it. rls_customer_facing_tables
-- owns the access questions for `conversations`.

INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-activity-test');

INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'La Espiga');

INSERT INTO public.whatsapp_connections
  (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001', '+593000000001', 'conn-activity-1', 'active');

-- Three conversations. The middle one is the case the migration is for: no
-- message timestamp, and an arrival time between the other two.
INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status, last_message_at, created_at)
VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001', '+593991111111', 'open',
   '2026-09-01T10:00:00Z', '2026-08-01T00:00:00Z'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001', '+593992222222', 'open',
   NULL, '2026-08-15T00:00:00Z'),
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001', '+593993333333', 'closed',
   '2026-08-20T10:00:00Z', '2026-07-01T00:00:00Z');

-- --- The column exists and is what it claims to be -------------------------

SELECT has_column('public', 'conversations', 'activity_at',
  'A1: conversations.activity_at exists');

SELECT col_not_null('public', 'conversations', 'activity_at',
  'A2: activity_at is NOT NULL — created_at is NOT NULL, so the COALESCE has no path to null');

-- --- The two rows that disagree with the old expression ---------------------

SELECT is(
  (SELECT activity_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000002'),
  '2026-08-15T00:00:00Z'::timestamptz,
  'A3: with no last_message_at, activity_at falls back to created_at rather than staying null'
);

SELECT is(
  (SELECT array_agg(id ORDER BY activity_at DESC, id DESC)
     FROM public.conversations
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  ARRAY['cccccccc-0000-0000-0000-000000000001',
        'cccccccc-0000-0000-0000-000000000003',
        'cccccccc-0000-0000-0000-000000000002']::uuid[],
  'A4: the null-timestamp conversation sorts by arrival, not to the top'
);

-- The positive control for A4. If this stops failing to match, A4 has stopped
-- testing anything: it would be asserting an order the old expression also
-- produced, and the migration could be reverted with the suite still green.
SELECT isnt(
  (SELECT array_agg(id ORDER BY last_message_at DESC, id DESC)
     FROM public.conversations
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  (SELECT array_agg(id ORDER BY activity_at DESC, id DESC)
     FROM public.conversations
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'A5: ordering by last_message_at still gives a DIFFERENT answer — the fixture exercises the defect'
);

SELECT is(
  (SELECT id FROM public.conversations
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    ORDER BY last_message_at DESC, id DESC LIMIT 1),
  'cccccccc-0000-0000-0000-000000000002'::uuid,
  'A6: and the answer it gives is the null row first — DESC implies NULLS FIRST'
);

-- --- Where last_message_at IS set, it wins ---------------------------------

SELECT is(
  (SELECT activity_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000001'),
  '2026-09-01T10:00:00Z'::timestamptz,
  'A7: with a last_message_at, activity_at is that and not created_at'
);

SELECT isnt(
  (SELECT activity_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000001'),
  (SELECT created_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000001'),
  'A8: ...and the fixture has them different, so A7 is not true by coincidence'
);

-- --- It is generated, not a snapshot ---------------------------------------

UPDATE public.conversations
   SET last_message_at = '2026-09-02T12:00:00Z'
 WHERE id = 'cccccccc-0000-0000-0000-000000000002';

SELECT is(
  (SELECT activity_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000002'),
  '2026-09-02T12:00:00Z'::timestamptz,
  'A9: activity_at follows last_message_at when a message finally arrives'
);

UPDATE public.conversations
   SET last_message_at = NULL
 WHERE id = 'cccccccc-0000-0000-0000-000000000002';

SELECT is(
  (SELECT activity_at FROM public.conversations WHERE id = 'cccccccc-0000-0000-0000-000000000002'),
  '2026-08-15T00:00:00Z'::timestamptz,
  'A10: and falls back again if it is cleared — it is generated, not written once'
);

-- --- It cannot be written ---------------------------------------------------
-- A generated column that could be set by hand would be a second, silently
-- authoritative source for the ordering, which is the shape of the original bug.

SELECT throws_ok(
  $$UPDATE public.conversations
       SET activity_at = '2030-01-01T00:00:00Z'
     WHERE id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '428C9',
  NULL,
  'A11: activity_at cannot be UPDATEd directly'
);

SELECT throws_ok(
  $$INSERT INTO public.conversations
      (organization_id, whatsapp_connection_id, contact_phone, activity_at)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
            '+593994444444', '2030-01-01T00:00:00Z')$$,
  '428C9',
  NULL,
  'A12: activity_at cannot be supplied on INSERT'
);

-- --- Scoping and the indexes the inbox depends on --------------------------

INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 'Otra Tienda', 'otra-activity-test');
INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'Otra Tienda');
INSERT INTO public.whatsapp_connections
  (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
        'dddddddd-0000-0000-0000-000000000002', '+593000000002', 'conn-activity-2', 'active');
INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status, last_message_at, created_at)
VALUES
  ('cccccccc-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000002', '+593999999999', 'open',
   '2026-09-05T10:00:00Z', '2026-09-05T10:00:00Z');

SELECT is(
  (SELECT count(*)::int FROM public.conversations
    WHERE organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  3,
  'A13: the other organization''s newer conversation is not in this one''s list'
);

SELECT has_index('public', 'conversations', 'idx_conversations_org_activity',
  'A14: the unfiltered inbox ordering index exists');

SELECT has_index('public', 'conversations', 'idx_conversations_org_status_activity',
  'A15: the status-filtered inbox ordering index exists');

-- The status vocabulary the inbox filter is built from. Asserted here because
-- the API's filter allowlist is a copy of it: a value added to the CHECK
-- without being added there is a conversation state no reviewer can filter to.
--
-- Read out of the catalog rather than written down twice. An earlier version of
-- this compared a literal array against itself, which is a sentence that reads
-- like a test and asserts nothing.
SELECT is(
  (SELECT string_agg(v, ',' ORDER BY v)
     FROM regexp_matches(
            (SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conname = 'conversations_status_check'),
            '''([a-z_]+)''::text', 'g'
          ) AS m(arr), unnest(arr) AS v),
  'closed,needs_human,open',
  'A16: the CHECK still admits exactly the three statuses the inbox filter offers'
);

SELECT throws_ok(
  $$INSERT INTO public.conversations
      (organization_id, whatsapp_connection_id, contact_phone, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
            '+593995555555', 'archived')$$,
  '23514',
  NULL,
  'A17: and refuses one outside it, so A16 is reading a constraint that bites'
);

SELECT * FROM finish();
ROLLBACK;
