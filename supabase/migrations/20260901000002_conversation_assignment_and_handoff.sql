-- Migration: conversation assignment and handoff
-- Date: 2026-09-01
-- Milestone: Sep 25 — handoff and assignment
--
-- WHAT HANDOFF ACTUALLY IS IN THIS PRODUCT
--
-- `conversations.status` has admitted three values since 2026-08-04, and until
-- now exactly one of them has ever been written. Nothing in the codebase has
-- ever set `needs_human` — not the ingest path, not the worker, not the API.
-- It is a declared state with no producer, which is why it is easy to read as
-- a label.
--
-- It is not a label. `process_inbound_message` enqueues a draft-generation job
-- only for conversations whose status is `open`
-- (20260805000017, lines 142-143):
--
--     IF (SELECT status FROM public.conversations WHERE id = v_conversation_id) = 'open' THEN
--
-- So setting `needs_human` **stops AI draft generation for that conversation**
-- and setting it back to `open` **resumes it**. Handoff is a per-conversation
-- kill switch for the automation, and this migration is what finally gives it
-- a producer. That is the reason the state change is written to an event table
-- rather than only to a column: "who turned the AI off for this customer, and
-- who turned it back on" is a question the product must be able to answer, and
-- a column only ever answers "what is it now".
--
-- WHY A NEW EVENT TABLE AND NOT `audit_logs`
--
-- ADR-009's audit boundary is explicit, and `apps/worker/src/e2e/milestone1.ts`
-- ships that boundary inside its evidence pack: `audit_logs` has exactly two
-- writers, `organization.create` and `invitation.accept`, and draft review
-- actions are recorded in `ai_draft_review_events` instead. Adding a third
-- writer to `audit_logs` would silently falsify a note that is printed for
-- humans to read. `conversation_events` is the same shape as
-- `ai_draft_review_events`, for the same reason that one exists.
--
-- WHY ASSIGNMENT IS COMPARE-AND-SET
--
-- Two reviewers open the inbox, both see a conversation nobody has claimed,
-- both click Assign to me. Last write wins, one of them silently loses it, and
-- both go on to draft a reply to the same customer. That is a double-work bug
-- in a product whose entire value is a human reading each reply.
--
-- So `assign_conversation` takes the assignee the caller *believes* is current
-- and refuses if that is not what the row says — the same shape as
-- `approve_draft`'s `expected_lock_version`, which exists for the same reason.
-- There is deliberately no force mode: a caller that wants to overwrite reads
-- the row first and passes what it read. Comparison is `IS DISTINCT FROM`, so
-- "I saw it unassigned" is expressible as NULL rather than needing a second
-- boolean argument to disambiguate "unassigned" from "don't care".

-- --------------------------------------------------------------------------
-- 1. Assignment columns
-- --------------------------------------------------------------------------

-- ON DELETE SET NULL, and nullable, following the correction made in
-- 20260819000003 to `ai_draft_review_events.actor_id`: a NOT NULL column with
-- ON DELETE SET NULL is a contradiction that makes erasing a reviewer fail at
-- delete time. Erasing a reviewer here leaves their conversations unassigned,
-- which is the right outcome — the conversation still needs someone.
--
-- WHY THERE IS NO `assigned_at` COLUMN
--
-- The first draft of this migration had one, with a CHECK that the two columns
-- agree: `(assigned_to IS NULL) = (assigned_at IS NULL)`. That constraint made
-- erasing a reviewer **impossible** — ON DELETE SET NULL nulls `assigned_to`,
-- leaves `assigned_at` set, and the CHECK then rejects the delete. It is the
-- same shape as the bug 20260819000003 was written to fix, re-created by
-- someone who had just finished reading about it. The erasure test caught it.
--
-- The fix is not a trigger to keep two columns in step. It is to stop keeping
-- the fact twice. `conversation_events` already records every assignment with
-- its timestamp, so "assigned since when" is a question the log answers and
-- the row does not need to. One field, one fact — the same reason the inbox
-- carries `awaiting_draft_id` instead of a boolean beside an id.
ALTER TABLE public.conversations
  ADD COLUMN assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.conversations.assigned_to IS
  'Reviewer responsible for this conversation, or NULL when unclaimed. Set only by '
  'assign_conversation, which is compare-and-set. Cleared if the profile is erased; '
  'when it was assigned is in conversation_events, not here.';

-- The inbox filters on this and orders by activity_at; without the index that
-- is a scan of the organization''s conversations per page.
CREATE INDEX IF NOT EXISTS idx_conversations_org_assignee_activity
  ON public.conversations (organization_id, assigned_to, activity_at DESC, id DESC);

-- Unassigned is the queue everyone looks at first, and it is the one case the
-- index above serves worst: a btree over a column that is NULL for most rows
-- still has to walk them. Partial, so it stays small and stays hot.
CREATE INDEX IF NOT EXISTS idx_conversations_org_unassigned_activity
  ON public.conversations (organization_id, activity_at DESC, id DESC)
  WHERE assigned_to IS NULL;

-- --------------------------------------------------------------------------
-- 2. conversation_events — the audit record for the two state changes above
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversation_events (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('assign', 'unassign', 'handoff', 'return_to_ai')),
  -- Nullable and ON DELETE SET NULL, per 20260819000003: the event outlives the
  -- person, so erasing a reviewer does not erase the record that a handoff
  -- happened. Who it was is lost; that it happened is not.
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Who the conversation was assigned TO. NULL for unassign, handoff and
  -- return_to_ai, which are not about a person.
  subject_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Composite FK: an event must belong to the same organization as the
-- conversation it describes. Without this, an event row could name a
-- conversation in another tenant and RLS would happily show it to this one.
ALTER TABLE public.conversation_events
  ADD CONSTRAINT conversation_events_conversation_org_fk
  FOREIGN KEY (organization_id, conversation_id)
  REFERENCES public.conversations(organization_id, id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_conversation_events_org_id
  ON public.conversation_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_id
  ON public.conversation_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_events_actor_id
  ON public.conversation_events(actor_id);

ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_events FORCE ROW LEVEL SECURITY;

-- Readable by members, writable by nobody through PostgREST. Every row is
-- written by the SECURITY DEFINER functions below, which is what makes the
-- table append-only in practice: there is no UPDATE or DELETE policy and no
-- grant that would let a session issue one.
CREATE POLICY conversation_events_select
  ON public.conversation_events
  FOR SELECT
  TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

GRANT SELECT ON public.conversation_events TO authenticated;
GRANT SELECT, INSERT ON public.conversation_events TO service_role;

-- --------------------------------------------------------------------------
-- 3. private.assign_conversation
-- --------------------------------------------------------------------------
--
-- SQLSTATE contract, P3C0x — a new range rather than more P3B0x, because those
-- are the draft-review codes and `error-mapper.ts` maps them to messages about
-- drafts. A conflict on a conversation is not "this draft has been modified".
--
--   P3C01  CONVERSATION_NOT_FOUND      404
--   P3C02  FORBIDDEN                   403
--   P3C03  ASSIGNEE_NOT_A_MEMBER       422
--   P3C04  ASSIGNMENT_CONFLICT         409
--   P3C05  INVALID_STATUS_TRANSITION   422

CREATE OR REPLACE FUNCTION private.assign_conversation(
  p_conversation_id UUID,
  p_assignee UUID,
  p_expected_assignee UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_actor UUID := auth.uid();
  v_action TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  -- Locked, and the organization is read OFF THE ROW rather than taken from the
  -- caller. A caller that could supply the organization could supply someone
  -- else's, and every check below would then be asking the wrong question.
  SELECT * INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.is_org_member(v_conv.organization_id, v_actor) THEN
    -- Deliberately the same answer a missing conversation gets. Whether a given
    -- id exists in some other tenant is not something an authenticated stranger
    -- gets to learn by watching which error comes back.
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.has_org_role(v_conv.organization_id, v_actor,
       ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  -- Compare-and-set. IS DISTINCT FROM so that NULL means "I saw it unassigned"
  -- rather than "no opinion" — see the header.
  IF v_conv.assigned_to IS DISTINCT FROM p_expected_assignee THEN
    RAISE EXCEPTION 'ASSIGNMENT_CONFLICT' USING ERRCODE = 'P3C04';
  END IF;

  IF p_assignee IS NOT NULL THEN
    -- The assignee must be a member of THIS organization. Without this check a
    -- reviewer could park a customer conversation on a stranger's id, and that
    -- id would then appear on the row and in the event log.
    IF NOT private.is_org_member(v_conv.organization_id, p_assignee) THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_A_MEMBER' USING ERRCODE = 'P3C03';
    END IF;

    v_action := 'assign';
    UPDATE public.conversations
       SET assigned_to = p_assignee,
           updated_at  = pg_catalog.now()
     WHERE id = p_conversation_id;
  ELSE
    v_action := 'unassign';
    UPDATE public.conversations
       SET assigned_to = NULL,
           updated_at  = pg_catalog.now()
     WHERE id = p_conversation_id;
  END IF;

  INSERT INTO public.conversation_events
    (organization_id, conversation_id, action, actor_id, subject_id,
     previous_status, new_status)
  VALUES
    (v_conv.organization_id, p_conversation_id, v_action, v_actor, p_assignee,
     v_conv.status, v_conv.status);

  -- Deliberately narrow. `contact_phone` is on the row this function just
  -- locked, and a RETURNING * here would put it on the wire for an operation
  -- that has nothing to do with the customer's number.
  RETURN jsonb_build_object(
    'conversation_id', p_conversation_id,
    'status', v_conv.status,
    'assigned_to', p_assignee
  );
END;
$$;

REVOKE ALL ON FUNCTION private.assign_conversation(UUID, UUID, UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- 4. private.set_conversation_handoff
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.set_conversation_handoff(
  p_conversation_id UUID,
  p_needs_human BOOLEAN,
  p_expected_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_actor UUID := auth.uid();
  v_target TEXT;
  v_action TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  SELECT * INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.is_org_member(v_conv.organization_id, v_actor) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.has_org_role(v_conv.organization_id, v_actor,
       ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  IF v_conv.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'ASSIGNMENT_CONFLICT' USING ERRCODE = 'P3C04';
  END IF;

  v_target := CASE WHEN p_needs_human THEN 'needs_human' ELSE 'open' END;

  -- Only open <-> needs_human. A closed conversation is not "handed off" and
  -- not "returned to the AI"; reopening it is a different decision with a
  -- different meaning, and quietly performing it here would make this function
  -- the reopen path by accident.
  IF v_conv.status NOT IN ('open', 'needs_human') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION' USING ERRCODE = 'P3C05';
  END IF;

  -- A no-op is allowed and recorded. Two reviewers both deciding a
  -- conversation needs a human is not an error, and the second one's intent is
  -- still worth having in the log.
  v_action := CASE WHEN p_needs_human THEN 'handoff' ELSE 'return_to_ai' END;

  UPDATE public.conversations
     SET status     = v_target,
         updated_at = pg_catalog.now()
   WHERE id = p_conversation_id;

  INSERT INTO public.conversation_events
    (organization_id, conversation_id, action, actor_id, subject_id,
     previous_status, new_status)
  VALUES
    (v_conv.organization_id, p_conversation_id, v_action, v_actor, NULL,
     v_conv.status, v_target);

  RETURN jsonb_build_object(
    'conversation_id', p_conversation_id,
    'status', v_target,
    'assigned_to', v_conv.assigned_to
  );
END;
$$;

REVOKE ALL ON FUNCTION private.set_conversation_handoff(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- 5. Public wrappers (PostgREST reaches `public` only)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_conversation(
  p_conversation_id UUID,
  p_assignee UUID,
  p_expected_assignee UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.assign_conversation(p_conversation_id, p_assignee, p_expected_assignee);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_conversation_handoff(
  p_conversation_id UUID,
  p_needs_human BOOLEAN,
  p_expected_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.set_conversation_handoff(p_conversation_id, p_needs_human, p_expected_status);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_conversation(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_conversation_handoff(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.assign_conversation(UUID, UUID, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_conversation_handoff(UUID, BOOLEAN, TEXT)
  TO authenticated, service_role;
