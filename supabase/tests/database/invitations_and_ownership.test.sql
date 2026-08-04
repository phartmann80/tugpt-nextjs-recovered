-- TuGPT.ai pgTAP Invitations and Organization Ownership Test Suite
-- Runs inside a single transaction that is rolled back at the end.

BEGIN;
SELECT plan(10);

-- =============================================================================
-- SETUP: Seed test database records (bypassing RLS as postgres user)
-- =============================================================================

-- Seed Users in auth.users
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner_a@tugpt.ai', '{"full_name": "Owner A"}'),
  ('22222222-2222-2222-2222-222222222222', 'admin_b@tugpt.ai', '{"full_name": "Admin B"}'),
  ('33333333-3333-3333-3333-333333333333', 'invitee_c@tugpt.ai', '{"full_name": "Invitee C"}'),
  ('44444444-4444-4444-4444-444444444444', 'rollback_d@tugpt.ai', '{"full_name": "Rollback D"}')
ON CONFLICT (id) DO NOTHING;

-- Seed Profiles
-- User D ('rollback_d@tugpt.ai') is seeded as a profile only and is
-- deliberately NOT added to organization_members below. Test 7 needs a
-- user who genuinely has no membership row before the test runs, so the
-- rollback assertion (Test 7b) proves the earlier INSERT was undone rather
-- than observing a pre-existing row created by an earlier test (User C
-- already has real membership from Test 3's accept_invitation() call,
-- which made it unsuitable as the Test 7 fixture).
INSERT INTO public.profiles (id, email, full_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner_a@tugpt.ai', 'Owner A'),
  ('22222222-2222-2222-2222-222222222222', 'admin_b@tugpt.ai', 'Admin B'),
  ('33333333-3333-3333-3333-333333333333', 'invitee_c@tugpt.ai', 'Invitee C'),
  ('44444444-4444-4444-4444-444444444444', 'rollback_d@tugpt.ai', 'Rollback D')
ON CONFLICT (id) DO NOTHING;

-- Seed Organizations
INSERT INTO public.organizations (id, name, slug) VALUES
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'Acme Hardening Corp', 'acme-hardening')
ON CONFLICT (id) DO NOTHING;

-- Seed Memberships
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '22222222-2222-2222-2222-222222222222', 'admin')
ON CONFLICT (organization_id, user_id) DO NOTHING;


-- =============================================================================
-- TEST 1: Wrong email rejection
-- =============================================================================
-- Seed an invitation for wrong_user@tugpt.ai
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES (
  'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'wrong_user@tugpt.ai',
  'agent',
  'tok_wrong_email_123',
  '11111111-1111-1111-1111-111111111111',
  NOW() + INTERVAL '1 day'
);

-- Try to accept with token as User C ('invitee_c@tugpt.ai')
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_wrong_email_123', '33333333-3333-3333-3333-333333333333')$$,
  'P0001',
  'Invitation email identity mismatch',
  'Test 1: Rejects accepting an invitation where email identity does not match'
);


-- =============================================================================
-- TEST 2: Expired invitation rejection
-- =============================================================================
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES (
  'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'invitee_c@tugpt.ai',
  'agent',
  'tok_expired_123',
  '11111111-1111-1111-1111-111111111111',
  NOW() - INTERVAL '1 hour'
);

SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_expired_123', '33333333-3333-3333-3333-333333333333')$$,
  'P0001',
  'Invitation token has expired',
  'Test 2: Rejects accepting an expired invitation token'
);


-- =============================================================================
-- TEST 3: Replay prevention (cannot accept twice)
-- =============================================================================
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES (
  'e3e3e3e3-e3e3-e3e3-e3e3-e3e3e3e3e3e3',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'invitee_c@tugpt.ai',
  'agent',
  'tok_valid_123',
  '11111111-1111-1111-1111-111111111111',
  NOW() + INTERVAL '1 day'
);

-- Accept first time (should return true)
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT public.accept_invitation('tok_valid_123', '33333333-3333-3333-3333-333333333333')),
  true,
  'Test 3a: Successfully accepts valid invitation'
);

-- Try to accept again (replay)
SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_valid_123', '33333333-3333-3333-3333-333333333333')$$,
  'P0001',
  'Invitation is no longer pending',
  'Test 3b: Blocks accepting the invitation a second time'
);


-- =============================================================================
-- TEST 4: Organization Ownership transfer
-- =============================================================================
SET LOCAL ROLE postgres;

-- Transfer ownership: assign owner role to User B (Admin B)
UPDATE public.organization_members
SET role = 'owner'
WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
  AND user_id = '22222222-2222-2222-2222-222222222222';

SELECT is(
  (SELECT role FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'),
  'owner'::organization_role,
  'Test 4: Successfully transfers ownership role to another member'
);


-- =============================================================================
-- TEST 5: Previous owner downgrade
-- =============================================================================
-- Downgrade User A (previous sole owner) to admin now that User B is owner
UPDATE public.organization_members
SET role = 'admin'
WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
  AND user_id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (SELECT role FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '11111111-1111-1111-1111-111111111111'),
  'admin'::organization_role,
  'Test 5: Successfully downgrades previous owner after transfer'
);


-- =============================================================================
-- TEST 6: Last owner protection
-- =============================================================================
-- Try to downgrade User B (currently the last and only owner of Acme Hardening Corp)
SELECT throws_ok(
  $$UPDATE public.organization_members SET role = 'admin' WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'$$,
  'P0001',
  'Action blocked: An organization must have at least one active owner',
  'Test 6a: Last owner downgrade is blocked'
);

-- Try to delete User B (last owner) membership record
SELECT throws_ok(
  $$DELETE FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'$$,
  'P0001',
  'Action blocked: An organization must have at least one active owner',
  'Test 6b: Last owner deletion is blocked'
);


-- =============================================================================
-- TEST 7: Transaction Rollback on Exception
-- =============================================================================
-- We start a block, insert a member, then do a trigger-violating action.
-- The exception must abort and rollback all changes in the nested block.
SET LOCAL ROLE postgres;

-- We try to run a subtransaction via a DO block.
-- Distinct tagged dollar-quote delimiters ($statement$ / $block$) are used so
-- the outer pgTAP string literal and the inner DO block body cannot collide,
-- unlike the previous "$$DO $$$ ... $$$$" construction which the Postgres
-- parser could not tokenize (outer $$ was closed by the inner DO's $$).
--
-- The exception handler intentionally catches only SQLSTATE 'P0001' — the
-- specific code raised by private.prevent_last_owner_removal() (a bare
-- `RAISE EXCEPTION` with no explicit SQLSTATE defaults to P0001, matching
-- every other throws_ok() assertion in this file). Catching WHEN OTHERS here
-- would silently swallow an unrelated failure (e.g. a broken INSERT) and let
-- this test pass for the wrong reason; anything other than P0001 re-raises
-- and correctly fails the test instead of being hidden.
--
-- Uses User D ('44444444-...'), seeded as a profile only with no existing
-- organization_members row. User C ('33333333-...') was used originally,
-- but Test 3 already grants User C real membership via accept_invitation(),
-- so inserting User C again here raised 23505 (duplicate key) before the
-- test could ever reach the intended P0001 ownership-protection path, and
-- Test 7b then observed User C's pre-existing row instead of a genuine
-- rollback. User D has no membership until this block runs, so the INSERT
-- below is guaranteed to be new, and Test 7b's zero-count assertion proves
-- the rollback rather than an accidental pre-existing row.
SELECT lives_ok(
  $statement$
  DO $block$
  BEGIN
    -- This insert is valid
    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '44444444-4444-4444-4444-444444444444', 'agent');

    -- This triggers P0001 via private.prevent_last_owner_removal()
    -- (User B is currently the organization's sole owner; see Tests 4-5).
    UPDATE public.organization_members
    SET role = 'admin'
    WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
      AND user_id = '22222222-2222-2222-2222-222222222222';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      -- Expected ownership-protection exception: the PL/pgSQL exception
      -- block's implicit subtransaction rolls back everything since BEGIN,
      -- including the earlier valid INSERT above. Swallow only this code.
      NULL;
  END;
  $block$;
  $statement$,
  'Test 7a: Traps exception inside nested query execution block'
);

-- Verify that User D's valid membership insert was rolled back along with
-- the exception, and that User C's unrelated membership (from Test 3) is
-- untouched by this assertion.
SELECT is(
  (
    SELECT COUNT(*)::int
    FROM public.organization_members
    WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
      AND user_id = '44444444-4444-4444-4444-444444444444'
  ),
  0,
  'Test 7b: Validates that aborted subtransaction changes are rolled back completely'
);


-- =============================================================================
-- CLEANUP: rollback at end of file (handled by ROLLBACK at end of test run)
-- =============================================================================

ROLLBACK;
