-- The contact entity.
--
-- ============================================================================
-- WHY THIS IS THE HIGHEST-LEVERAGE ITEM ON THE ROADMAP
-- ============================================================================
--
-- Today a customer is a string. `conversations.contact_phone` is a bare TEXT
-- column (20260804000005:8), and there is nowhere to record anything else
-- about the person on the other end — not a name, not a note, not a history
-- that survives a conversation being closed.
--
-- Six roadmap items resolve to "a thing we can attach facts to": CRM (12),
-- sales pipeline (13), appointments (14), invoices (15), campaigns (25), and
-- most of the follow-up engine (11). Each of them, built against a phone
-- string, invents its own half of this table. Built once, they get cheaper.
--
-- ============================================================================
-- IDENTITY IS (organization_id, phone) — NOT (organization, number, phone)
-- ============================================================================
--
-- Conversations are keyed on `(organization_id, whatsapp_connection_id,
-- contact_phone)`: the same person messaging two of a business's WhatsApp
-- numbers has two conversations. That is correct for conversations, because a
-- thread belongs to a number.
--
-- It is wrong for a contact. The person is one person. If contact identity
-- included the connection, a business with a sales number and a support number
-- would hold two records for one human, and every feature above would have to
-- reconcile them — which is exactly the work this table exists to avoid.
--
-- This also makes the entity load-bearing for roadmap item 24 (multiple
-- numbers per organization), which is otherwise blocked on having any notion
-- of a person that spans numbers.
--
-- ============================================================================
-- WHY conversations.contact_phone STAYS, AND WHY IT CANNOT DRIFT
-- ============================================================================
--
-- Two columns holding the same fact is how data goes wrong: one gets updated,
-- the other does not, and the disagreement is discovered by a customer
-- receiving somebody else's reply. `conversations.contact_phone` is kept here
-- rather than dropped, because dropping it means changing the ingest lookup,
-- the web service's select list, the masking path and the thread API in the
-- same migration that introduces the table — a blast radius that turns a
-- schema addition into a rewrite.
--
-- The duplicate is made safe rather than tolerated, by two triggers that close
-- the two directions drift can come from:
--
--   * `contacts.phone` is **immutable** (§2). A phone number is not an
--     attribute of a contact, it IS the contact — changing it does not correct
--     a record, it points at a different person, which is an insert and a
--     merge, not an update. So the contact side cannot move.
--
--   * `conversations.contact_id` is **derived and checked** (§5): filled from
--     (organization_id, contact_phone) when absent, and rejected when present
--     and disagreeing, on INSERT and on UPDATE. So the conversation side
--     cannot move either, including if `contact_phone` is later edited.
--
-- Neither column can change out from under the other, which is what makes `I3`
-- — the two never disagree — a mechanism and not a hope. `I3` asserts it
-- anyway, because a claim nobody tests is the same failure one level up.
--
-- Removing `conversations.contact_phone` is a follow-up once its readers move
-- to the join. That is a named end, not an open question.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- The WhatsApp identifier, exactly as the provider gives it. Deliberately
  -- not normalised to E.164 here: the provider's value is what inbound
  -- messages arrive with and what conversations are matched on, so rewriting
  -- it would break the join it exists to serve. Normalisation belongs in a
  -- later migration that also fixes the matching, together, or not at all.
  phone TEXT NOT NULL,

  -- Nullable because WhatsApp does not always give one and nobody has typed
  -- one yet. A contact with no name is still a contact; forcing a placeholder
  -- would put "Unknown" in a CRM and make it indistinguishable from a real
  -- name somebody entered.
  display_name TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT contacts_phone_length CHECK (char_length(phone) BETWEEN 1 AND 32),
  CONSTRAINT contacts_display_name_length CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200)
);

-- One contact per person per organization. This is the identity claim of the
-- whole table, so it is a constraint and not a convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_phone
  ON public.contacts (organization_id, phone);

-- The listing query every later feature will run.
CREATE INDEX IF NOT EXISTS idx_contacts_org_created
  ON public.contacts (organization_id, created_at DESC);

COMMENT ON TABLE public.contacts IS
  'A person an organization talks to. Identity is (organization_id, phone) — '
  'deliberately not scoped to a WhatsApp number, so one human messaging two of '
  'a business''s numbers is one contact.';

-- ---------------------------------------------------------------------------
-- 2. phone is immutable
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.contacts_reject_phone_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    RAISE EXCEPTION 'contacts.phone is immutable; a different number is a different contact'
      USING ERRCODE = 'P3E01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contacts_phone_immutable
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION private.contacts_reject_phone_change();

-- Also keeps updated_at honest, since the RPC below is not the only writer.
CREATE OR REPLACE FUNCTION private.contacts_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER contacts_set_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION private.contacts_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Resolve-or-create
-- ---------------------------------------------------------------------------

-- Called by the ingest path for every inbound message, so it must be cheap and
-- must not fail on a race. Two webhook deliveries for the same new contact
-- arrive concurrently in normal operation; ON CONFLICT is the difference
-- between that being ordinary and it being a dropped message.
CREATE OR REPLACE FUNCTION private.resolve_contact(
  p_organization_id UUID,
  p_phone TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.contacts (organization_id, phone)
  VALUES (p_organization_id, p_phone)
  ON CONFLICT (organization_id, phone) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.contacts
    WHERE organization_id = p_organization_id AND phone = p_phone;
  END IF;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION private.resolve_contact(UUID, TEXT) IS
  'Idempotent. DO NOTHING then re-select rather than DO UPDATE: there is '
  'nothing to update, and an UPDATE would bump updated_at on every inbound '
  'message, making the column mean "last messaged" instead of "last edited".';

-- ---------------------------------------------------------------------------
-- 4. conversations.contact_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE RESTRICT;

-- RESTRICT, not CASCADE and not SET NULL. Deleting a contact who has
-- conversations would either destroy the message history (CASCADE) or leave
-- conversations pointing at nobody (SET NULL). Both are worse than refusing:
-- a contact with history is not deletable, and the day that needs to change,
-- it needs to change deliberately with a decision about what happens to the
-- messages.

-- ---------------------------------------------------------------------------
-- 5. The link is maintained by the database, not by its callers
-- ---------------------------------------------------------------------------

-- `contact_id` could have been filled by editing `process_inbound_message`,
-- the one writer that exists today. It is done here instead, for two reasons.
--
-- The first is that `process_inbound_message` is a 180-line function defined in
-- 20260805000017. Adding two lines to it means re-declaring the whole body in
-- this file with CREATE OR REPLACE, after which there are two copies of that
-- function in the migration history and the next person to edit the older one
-- silently edits nothing. A two-line change is not worth a duplicate.
--
-- The second is the real one: a writer that must remember something eventually
-- forgets. The e2e harness inserts conversations. The pgTAP suites insert
-- conversations. A future outbound-initiated conversation will insert one.
-- Each of those is a place the link can be missed, and a missed link is a
-- conversation whose customer does not exist.
--
-- So the rule is enforced once, as a rule:
--
--     contact_id = the contact for (organization_id, contact_phone)
--
-- with two halves that answer the two ways a writer can be wrong:
--
--   * A writer that does not set `contact_id` — or that changes
--     `contact_phone` and leaves the link alone — gets it filled. The link
--     follows the fact, so nobody has to remember it.
--
--   * A writer that sets `contact_id` to something else is REFUSED (P3E02).
--     Silently correcting it would be worse: the write would appear to
--     succeed while meaning something other than what it said.
--
-- Together those make `I3` — conversations.contact_phone and contacts.phone
-- never disagree — a mechanism rather than a hope. With `contacts.phone`
-- immutable as well, the duplicated column cannot drift in either direction:
-- the contact's phone cannot change, and a conversation cannot come to point
-- at a contact whose phone is not its own.
--
-- The known end of this rule: merging two contacts (one human, two numbers) is
-- a real future need, and it necessarily points a conversation at a contact
-- whose phone differs from `conversations.contact_phone`. That migration will
-- have to replace this trigger and decide what `contact_phone` means
-- afterwards — most likely by dropping it, which is the follow-up already
-- named in the header. It is a known successor, not an unhandled case.
CREATE OR REPLACE FUNCTION private.conversations_link_contact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_expected UUID;
BEGIN
  -- The hot path, and the reason it is first: every inbound message UPDATEs
  -- last_message_at on an existing conversation. If nothing that determines
  -- the link changed, there is nothing to check, and resolving anyway would
  -- put an index probe on the ingest path for no result.
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.contact_phone   IS NOT DISTINCT FROM OLD.contact_phone
     AND NEW.contact_id      IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;

  v_expected := private.resolve_contact(NEW.organization_id, NEW.contact_phone);

  IF NEW.contact_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id) THEN
    -- Absent, or untouched while the phone moved: derive it.
    NEW.contact_id := v_expected;
  ELSIF NEW.contact_id IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'conversations.contact_id must be the contact for (organization_id, contact_phone)'
      USING ERRCODE = 'P3E02';
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT and UPDATE both. UPDATE matters because `contact_phone` is not
-- immutable on conversations: if it is ever changed, an unmaintained
-- `contact_id` would still point at the previous person, which is the exact
-- failure — a reply routed to the wrong customer — that this column was added
-- to make impossible.
CREATE TRIGGER conversations_link_contact
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION private.conversations_link_contact();

-- ---------------------------------------------------------------------------
-- 6. Backfill
-- ---------------------------------------------------------------------------

-- One contact per distinct (organization_id, contact_phone) already in
-- `conversations`. Note the DISTINCT: an organization with two WhatsApp
-- numbers that both talked to the same person has two conversation rows and
-- must get ONE contact, which is the whole identity argument in the header
-- expressed as a backfill.
INSERT INTO public.contacts (organization_id, phone)
SELECT DISTINCT c.organization_id, c.contact_phone
FROM public.conversations c
ON CONFLICT (organization_id, phone) DO NOTHING;

UPDATE public.conversations c
SET contact_id = ct.id
FROM public.contacts ct
WHERE ct.organization_id = c.organization_id
  AND ct.phone = c.contact_phone
  AND c.contact_id IS NULL;

-- Only now can the column be required. Doing this before the backfill would
-- fail on any non-empty database, and doing it never would leave the FK
-- optional — which means the first reader has to handle NULL, and every reader
-- after it copies that.
ALTER TABLE public.conversations
  ALTER COLUMN contact_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_contact
  ON public.conversations (contact_id, activity_at DESC);

-- ---------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- `private.is_org_member` rather than a hand-rolled EXISTS against
-- organization_members: the same predicate spelled twice is two things to keep
-- in agreement, and `conversations_select` — the policy a contact is always
-- read alongside — already uses the helper.
CREATE POLICY contacts_select
  ON public.contacts
  FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );

-- Read-only from the application, and the grant says so. Contacts are created
-- by `resolve_contact` under the definer, reached through the conversation
-- trigger; nothing in the app writes this table and no screen needs to yet.
--
-- The grant is the security boundary, not the policy. A policy without a
-- matching table privilege is inert, and a table privilege without a policy is
-- the whole table — so a write policy shipped "for later", against a grant
-- nobody audited, is how a read-only table quietly becomes writable. There is
-- no write policy here for the same reason there is no write grant.
GRANT SELECT ON public.contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.contacts TO service_role;
REVOKE ALL ON public.contacts FROM anon;
REVOKE ALL ON public.contacts FROM authenticated;
GRANT SELECT ON public.contacts TO authenticated;

-- The definer functions are reached through the trigger, never called
-- directly. Executable by nobody but their owner.
REVOKE ALL ON FUNCTION private.resolve_contact(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.conversations_link_contact() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.contacts_reject_phone_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.contacts_touch_updated_at() FROM PUBLIC, anon, authenticated;
