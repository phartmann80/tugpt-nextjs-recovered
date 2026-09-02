-- contact_entity.test.sql
--
-- `public.contacts` — the person on the other end of a WhatsApp thread.
--
-- Two claims in 20260902000002 are load-bearing, and everything else in this
-- file is scaffolding around them.
--
-- The first is IDENTITY. A contact is (organization_id, phone) and deliberately
-- NOT (organization_id, whatsapp_connection_id, phone). A suite that only ever
-- used one WhatsApp connection would pass identically under either rule, so
-- I1 uses two connections and one human, and asserts they meet in one row.
-- That single assertion is the difference between a contact table and a
-- per-thread label, and it is what roadmap item 24 (multiple numbers per
-- organization) rests on.
--
-- The second is NO DRIFT. `conversations.contact_phone` still exists next to
-- the new `conversations.contact_id`, and two columns holding one fact is how
-- a reply reaches the wrong customer. The migration closes both directions —
-- contacts.phone is immutable, and conversations.contact_id is derived and
-- rejected when it disagrees — so M2/M4/M5 and P1 are testing a mechanism, not
-- a convention. M3 and P2 are their positive controls: without them, a trigger
-- that rejected *every* write would pass this file.

BEGIN;
SELECT plan(48);

-- --- Fixtures --------------------------------------------------------------
-- Written as the owning role so RLS is not in the way for the semantic
-- assertions; the access questions get their own section at the end, where the
-- role is switched explicitly.

INSERT INTO auth.users (id, email) VALUES
  ('11111111-ce00-0000-0000-000000000001', 'member@espiga.test'),
  ('11111111-ce00-0000-0000-000000000002', 'outsider@other.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-ce00-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-contact-test'),
  ('aaaaaaaa-ce00-0000-0000-000000000002', 'Ferretería El Tornillo', 'tornillo-contact-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-ce00-0000-0000-000000000001', '11111111-ce00-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-ce00-0000-0000-000000000002', '11111111-ce00-0000-0000-000000000002', 'owner');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('dddddddd-ce00-0000-0000-000000000001', 'aaaaaaaa-ce00-0000-0000-000000000001', 'La Espiga'),
  ('dddddddd-ce00-0000-0000-000000000002', 'aaaaaaaa-ce00-0000-0000-000000000002', 'El Tornillo');

-- TWO connections for the first organization. This is the fixture the identity
-- claim is tested against: a business with a sales number and a support number.
INSERT INTO public.whatsapp_connections
  (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES
  ('bbbbbbbb-ce00-0000-0000-000000000001', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'dddddddd-ce00-0000-0000-000000000001', '+593000000001', 'conn-ce-sales', 'active'),
  ('bbbbbbbb-ce00-0000-0000-000000000002', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'dddddddd-ce00-0000-0000-000000000001', '+593000000002', 'conn-ce-support', 'active'),
  ('bbbbbbbb-ce00-0000-0000-000000000003', 'aaaaaaaa-ce00-0000-0000-000000000002',
   'dddddddd-ce00-0000-0000-000000000002', '+593000000003', 'conn-ce-tornillo', 'active');

-- --- C: the table is what it claims to be ----------------------------------

SELECT has_table('public', 'contacts', 'C1: public.contacts exists');

SELECT col_not_null('public', 'contacts', 'phone',
  'C2: phone is NOT NULL — a contact without a number is not a contact');

SELECT col_is_null('public', 'contacts', 'display_name',
  'C3: display_name is nullable — WhatsApp does not always give one, and a '
  '"Unknown" placeholder would be indistinguishable from a name somebody typed');

SELECT is(
  (SELECT indisunique FROM pg_index
    WHERE indexrelid = 'public.idx_contacts_org_phone'::regclass),
  true,
  'C4: (organization_id, phone) is UNIQUE — identity is a constraint, not a convention'
);

SELECT is(
  (SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_contact_id_fkey'),
  'r'::"char",
  'C5: conversations.contact_id is ON DELETE RESTRICT — refusing beats destroying '
  'history (CASCADE) or orphaning conversations (SET NULL)'
);

SELECT col_not_null('public', 'conversations', 'contact_id',
  'C6: conversations.contact_id is NOT NULL — an optional FK makes the first '
  'reader handle NULL and every reader after it copy that');

-- --- I: identity spans WhatsApp numbers ------------------------------------
-- The assertion the table exists for.

-- One human, +593991111111, messages both of the bakery's numbers.
INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status, last_message_at)
VALUES
  ('cccccccc-ce00-0000-0000-000000000001', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'bbbbbbbb-ce00-0000-0000-000000000001', '+593991111111', 'open', '2026-09-01T10:00:00Z'),
  ('cccccccc-ce00-0000-0000-000000000002', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'bbbbbbbb-ce00-0000-0000-000000000002', '+593991111111', 'open', '2026-09-01T11:00:00Z');

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593991111111'),
  1,
  'I1: two conversations on two WhatsApp numbers, one human, ONE contact — '
  'identity is (org, phone) and not (org, number, phone)'
);

SELECT is(
  (SELECT count(DISTINCT contact_id)::int FROM public.conversations
    WHERE id IN ('cccccccc-ce00-0000-0000-000000000001',
                 'cccccccc-ce00-0000-0000-000000000002')),
  1,
  'I1b: and both conversations point at that one contact'
);

-- The same number at a different business is a different person to that
-- business. Identity is scoped to the organization, which is the tenancy
-- boundary the whole schema is built on.
INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES
  ('cccccccc-ce00-0000-0000-000000000003', 'aaaaaaaa-ce00-0000-0000-000000000002',
   'bbbbbbbb-ce00-0000-0000-000000000003', '+593991111111', 'open');

SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE phone = '+593991111111'),
  2,
  'I2: the same number at another organization is a second contact — identity '
  'does not cross the tenancy boundary'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.conversations c
     JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE ct.phone IS DISTINCT FROM c.contact_phone
       OR ct.organization_id IS DISTINCT FROM c.organization_id),
  0,
  'I3: no conversation disagrees with its contact — the duplicated column '
  'cannot drift'
);

-- --- M: the link is maintained, and disagreement is refused -----------------

SELECT isnt(
  (SELECT contact_id FROM public.conversations
    WHERE id = 'cccccccc-ce00-0000-0000-000000000001'),
  NULL,
  'M1: a conversation inserted without contact_id gets one — no writer has to remember'
);

-- The wrong contact for this conversation: right shape, real row, other org.
SELECT throws_ok(
  $$INSERT INTO public.conversations
      (organization_id, whatsapp_connection_id, contact_phone, contact_id, status)
    VALUES ('aaaaaaaa-ce00-0000-0000-000000000001',
            'bbbbbbbb-ce00-0000-0000-000000000001', '+593992222222',
            (SELECT id FROM public.contacts
              WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000002'
                AND phone = '+593991111111'),
            'open')$$,
  'P3E02',
  NULL,
  'M2: a conversation pointed at somebody else''s contact is refused (P3E02) — '
  'this is the wrong-customer bug, rejected at the write'
);

-- Positive control for M2. Without this, a trigger that rejected every
-- contact_id whatsoever would pass M2 and the column would be unusable.
--
-- A fresh number, because `conversations_org_connection_phone_unique` already
-- holds (org, connection, phone) for the rows above — reusing one would fail
-- for a reason that has nothing to do with the contact link, which is a test
-- passing or failing on the wrong constraint.
SELECT lives_ok(
  $$INSERT INTO public.conversations
      (id, organization_id, whatsapp_connection_id, contact_phone, contact_id, status)
    VALUES ('cccccccc-ce00-0000-0000-000000000004',
            'aaaaaaaa-ce00-0000-0000-000000000001',
            'bbbbbbbb-ce00-0000-0000-000000000001', '+593997777777',
            private.resolve_contact('aaaaaaaa-ce00-0000-0000-000000000001',
                                    '+593997777777'),
            'open')$$,
  'M3: the RIGHT contact_id is accepted — M2 rejects disagreement, not the column'
);

-- contact_phone is not immutable on conversations. If it is ever edited, an
-- unmaintained contact_id would still point at the previous person.
UPDATE public.conversations
SET contact_phone = '+593993333333'
WHERE id = 'cccccccc-ce00-0000-0000-000000000004';

SELECT is(
  (SELECT ct.phone FROM public.conversations c
     JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = 'cccccccc-ce00-0000-0000-000000000004'),
  '+593993333333',
  'M4: changing contact_phone re-resolves contact_id — the link follows the fact'
);

SELECT throws_ok(
  $$UPDATE public.conversations
       SET contact_id = (SELECT id FROM public.contacts
                          WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000002')
     WHERE id = 'cccccccc-ce00-0000-0000-000000000004'$$,
  'P3E02',
  NULL,
  'M5: repointing an existing conversation at the wrong contact is refused too — '
  'INSERT-only enforcement would leave UPDATE as the way in'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'),
  3,
  'M6: the bakery has exactly the three distinct numbers that have written to it'
);

-- The trigger returns early when nothing that determines the link changed.
-- That branch is on the ingest hot path — every inbound message updates
-- last_message_at — so it needs to be shown to leave the link alone rather
-- than assumed to.
--
-- Recorded deliberately: M7 does NOT die if the early return is deleted. It
-- was mutation-tested, and removing that branch escapes every assertion in
-- this file, because the branch is an optimisation — it skips a resolve whose
-- answer is already known, and the row comes out the same either way. There is
-- no honest behavioural assertion for "did less work", and a timing assertion
-- in pgTAP would fail on a slow machine instead of on a wrong change. So the
-- branch is covered by M7 for its *result* and by nothing for its *cost*, and
-- a reviewer removing it should know they are trading ingest work for nothing,
-- not fixing an untested line.
UPDATE public.conversations
SET last_message_at = '2026-09-02T12:00:00Z'
WHERE id = 'cccccccc-ce00-0000-0000-000000000001';

SELECT is(
  (SELECT ct.phone FROM public.conversations c
     JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = 'cccccccc-ce00-0000-0000-000000000001'),
  '+593991111111',
  'M7: an ordinary last_message_at update leaves the link alone'
);

-- --- P: contacts.phone is immutable ----------------------------------------

SELECT throws_ok(
  $$UPDATE public.contacts SET phone = '+593999999999'
     WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
       AND phone = '+593991111111'$$,
  'P3E01',
  NULL,
  'P1: phone cannot be updated (P3E01) — a different number is a different '
  'person, which is an insert and a merge, not an edit'
);

-- Positive control for P1.
SELECT lives_ok(
  $$UPDATE public.contacts SET display_name = 'Rosa Jiménez'
     WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
       AND phone = '+593991111111'$$,
  'P2: other columns update normally — P1 refuses a phone change, not every write'
);

SELECT is(
  (SELECT display_name FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593991111111'),
  'Rosa Jiménez',
  'P2b: and the value actually landed'
);

-- Not `updated_at > created_at`: both come from now(), which is the
-- transaction timestamp and therefore constant for the whole of this file. An
-- assertion in that shape can never fail here, and a test that cannot fail is
-- not evidence. What is actually checkable is that the trigger OVERRIDES a
-- value the writer supplied, which is the guarantee the column depends on.
UPDATE public.contacts
SET display_name = 'Rosa Jiménez', updated_at = '2020-01-01T00:00:00Z'
WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
  AND phone = '+593991111111';

SELECT ok(
  (SELECT updated_at FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593991111111') > '2020-01-02T00:00:00Z'::timestamptz,
  'P3: the touch trigger overrides a caller-supplied updated_at — the column '
  'records when the row changed, not what the writer claimed'
);

SELECT throws_ok(
  $$INSERT INTO public.contacts (organization_id, phone)
    VALUES ('aaaaaaaa-ce00-0000-0000-000000000001', '')$$,
  '23514',
  NULL,
  'P4: an empty phone is refused by the length check'
);

-- --- R: resolve_contact -----------------------------------------------------

SELECT is(
  private.resolve_contact('aaaaaaaa-ce00-0000-0000-000000000001', '+593994444444'),
  private.resolve_contact('aaaaaaaa-ce00-0000-0000-000000000001', '+593994444444'),
  'R1: resolve_contact is idempotent — two webhook deliveries for one new '
  'contact is ordinary traffic, not a dropped message'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593994444444'),
  1,
  'R1b: and it made exactly one row'
);

-- DO NOTHING then re-select, not DO UPDATE: an UPDATE on every inbound message
-- would silently redefine updated_at as "last messaged".
--
-- Asserted on `ctid` rather than on updated_at, for the same reason as P3 —
-- now() is constant within this transaction, so "updated_at did not move"
-- cannot fail here whatever the function does. `ctid` can: an UPDATE writes a
-- new row version and moves it, in the same transaction, every time.
CREATE TEMP TABLE _r2_before AS
SELECT ctid AS loc FROM public.contacts
 WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
   AND phone = '+593994444444';

SELECT private.resolve_contact('aaaaaaaa-ce00-0000-0000-000000000001', '+593994444444');

SELECT is(
  (SELECT ctid::text FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593994444444'),
  (SELECT loc::text FROM _r2_before),
  'R2: resolving an existing contact writes no new row version — updated_at '
  'means "last edited", not "last messaged"'
);

-- Positive control for R2: ctid does move when something really updates.
UPDATE public.contacts SET display_name = 'moved'
 WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
   AND phone = '+593994444444';

SELECT isnt(
  (SELECT ctid::text FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593994444444'),
  (SELECT loc::text FROM _r2_before),
  'R2b: a real update does move it — R2 is watching something that can change'
);

-- --- D: deletion ------------------------------------------------------------

SELECT throws_ok(
  $$DELETE FROM public.contacts
     WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
       AND phone = '+593991111111'$$,
  '23503',
  NULL,
  'D1: a contact with conversations cannot be deleted (RESTRICT)'
);

SELECT lives_ok(
  $$DELETE FROM public.contacts
     WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
       AND phone = '+593994444444'$$,
  'D2: a contact with no conversations deletes — D1 is RESTRICT, not immortality'
);

-- Organizations are SOFT-deleted: `trigger_soft_delete_organizations` sets
-- deleted_at and returns NULL, cancelling the hard delete. So the
-- ON DELETE CASCADE declared on contacts.organization_id never fires in this
-- system, and an assertion that "deleting the org removes its contacts" would
-- pass on a delete that removed zero rows — which is what it did before this
-- was checked. The behaviour worth pinning is the real one.
SELECT lives_ok(
  $$DELETE FROM public.organizations WHERE id = 'aaaaaaaa-ce00-0000-0000-000000000002'$$,
  'D3: deleting an organization is accepted — and turned into a soft delete'
);

SELECT isnt(
  (SELECT deleted_at FROM public.organizations
    WHERE id = 'aaaaaaaa-ce00-0000-0000-000000000002'),
  NULL,
  'D3b: the organization row survives, marked deleted'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000002'),
  1,
  'D3c: and its contacts survive with it — a soft-deleted organization keeps '
  'its history, which is the point of soft-deleting it'
);

-- --- E: the ingest path -----------------------------------------------------
-- End to end through the real RPC, because the trigger is only worth anything
-- if the one writer that exists in production actually goes through it.

SELECT public.ingest_whatsapp_message_event(
  'conn-ce-sales', 'meta', 'wamid.ce001', 'message',
  '00000000000000000000000000000000000000000000000000000000000000ce',
  'wamid.ce001', '+593995555555', 'text', 'Buenos días',
  '2026-09-02T09:00:00Z'::timestamptz, 'req-ce001'
);

SELECT lives_ok(
  $$SELECT * FROM public.process_inbound_message(
      (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.ce001'))$$,
  'E1: process_inbound_message still succeeds with contact_id NOT NULL in place'
);

SELECT is(
  (SELECT ct.phone
     FROM public.conversations c
     JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.contact_phone = '+593995555555'),
  '+593995555555',
  'E2: the conversation it created is linked to a contact for that number'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.conversations c
     JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE ct.phone IS DISTINCT FROM c.contact_phone),
  0,
  'E3: I3 still holds after the ingest path has run'
);

-- --- B: the backfill --------------------------------------------------------
-- The backfill ran during the migration, against whatever was there. Asserting
-- on its result after the fact proves nothing about a database that had rows.
-- So it is replayed here: the pre-migration shape is reconstructed (trigger
-- off, column nullable) and the migration's own two statements are run over it.
--
-- The case that matters is the same one as I1 — one human, two of the
-- business's numbers — because a backfill without DISTINCT produces two
-- contacts here and a unique-violation on the second, and a backfill that
-- keyed on the connection would produce two contacts and no error at all.
--
-- The limitation, stated rather than hidden: these are a COPY of the
-- migration's two statements, not the migration's own. SQL cannot read the
-- file. So B tests that this approach is sound on pre-migration data; it does
-- not detect somebody later editing the backfill in 20260902000002 to
-- something else. What does hold the line there is that the same rule is
-- enforced by the trigger for every writer, so a wrong backfill would be
-- caught by I3/E3 the moment any row went through it.

ALTER TABLE public.conversations DISABLE TRIGGER conversations_link_contact;
ALTER TABLE public.conversations ALTER COLUMN contact_id DROP NOT NULL;

INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, contact_id, status)
VALUES
  ('cccccccc-ce00-0000-0000-0000000000b1', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'bbbbbbbb-ce00-0000-0000-000000000001', '+593996666666', NULL, 'open'),
  ('cccccccc-ce00-0000-0000-0000000000b2', 'aaaaaaaa-ce00-0000-0000-000000000001',
   'bbbbbbbb-ce00-0000-0000-000000000002', '+593996666666', NULL, 'open');

SELECT lives_ok(
  $$INSERT INTO public.contacts (organization_id, phone)
    SELECT DISTINCT c.organization_id, c.contact_phone
    FROM public.conversations c
    ON CONFLICT (organization_id, phone) DO NOTHING$$,
  'B1: the backfill insert runs over pre-migration rows without conflict'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id = 'aaaaaaaa-ce00-0000-0000-000000000001'
      AND phone = '+593996666666'),
  1,
  'B2: two pre-existing conversations on two numbers backfill to ONE contact — '
  'the DISTINCT is the identity claim expressed as a backfill'
);

UPDATE public.conversations c
SET contact_id = ct.id
FROM public.contacts ct
WHERE ct.organization_id = c.organization_id
  AND ct.phone = c.contact_phone
  AND c.contact_id IS NULL;

SELECT is(
  (SELECT count(*)::int FROM public.conversations WHERE contact_id IS NULL),
  0,
  'B3: the backfill update leaves no conversation unlinked, so SET NOT NULL '
  'can follow it'
);

SELECT lives_ok(
  $$ALTER TABLE public.conversations ALTER COLUMN contact_id SET NOT NULL$$,
  'B4: and SET NOT NULL succeeds, which is the step that would fail on any '
  'non-empty database if the backfill were wrong'
);

ALTER TABLE public.conversations ENABLE TRIGGER conversations_link_contact;

-- --- S: who may read, and who may write ------------------------------------

SELECT table_privs_are(
  'public', 'contacts', 'authenticated', ARRAY['SELECT'],
  'S1: authenticated holds SELECT and nothing else — the grant is the boundary, '
  'and a write policy against an unaudited grant is how a read-only table '
  'quietly becomes writable'
);

SELECT table_privs_are(
  'public', 'contacts', 'anon', ARRAY[]::text[],
  'S2: anon holds nothing'
);

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'contacts' AND cmd <> 'SELECT'),
  0,
  'S3: there is no write policy on contacts at all'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
    WHERE oid = 'public.contacts'::regclass),
  'S4: RLS is enabled'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'private.resolve_contact(uuid,text)', 'EXECUTE'),
  'S5: authenticated cannot call resolve_contact — it is reached through the '
  'trigger, never directly'
);

SELECT ok(
  NOT has_function_privilege('anon', 'private.resolve_contact(uuid,text)', 'EXECUTE'),
  'S5b: nor can anon'
);

-- Under a member's JWT, RLS shows exactly that member's organization.
SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-ce00-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT count(*) FROM public.contacts) > 0,
  'S6: a member sees their organization''s contacts'
);

SELECT is(
  (SELECT count(*)::int FROM public.contacts
    WHERE organization_id <> 'aaaaaaaa-ce00-0000-0000-000000000001'),
  0,
  'S7: and sees no other organization''s'
);

SELECT throws_ok(
  $$UPDATE public.contacts SET display_name = 'injected'$$,
  '42501',
  NULL,
  'S8: a member cannot write, even to their own organization''s contacts'
);

SET LOCAL ROLE postgres;

SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT count(*) FROM public.contacts$$,
  '42501',
  NULL,
  'S9: anon cannot read the table at all'
);

SET LOCAL ROLE postgres;

SELECT * FROM finish();
ROLLBACK;
