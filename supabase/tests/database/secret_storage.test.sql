-- secret_storage.test.sql
--
-- Encrypted credential storage — `platform_secrets` and `organization_secrets`
-- (migration 20260903000003).
--
-- The database holds ciphertext and no key, so most of what can go wrong here
-- is not cryptographic; it is access and shape. Four claims carry the file.
--
-- NOBODY BUT service_role TOUCHES THESE TABLES (A1-A6). Not `anon`, not
-- `authenticated`, and not with a narrowed revoke that leaves REFERENCES and
-- TRIGGER behind — which is exactly what dcfe72c had to correct on two other
-- tables. On a credential table TRIGGER is not theoretical: it lets a role
-- attach a function that fires on every write.
--
-- THE METADATA READER RETURNS NO KEY MATERIAL (M1-M5). A settings screen needs
-- "HubSpot — connected, expires in 30 days". It must never get `ciphertext`,
-- `iv`, `auth_tag` or `key_id`. M2 asserts the exact returned column set, so
-- adding a column to that function is a deliberate act rather than an
-- accident.
--
-- WRONG-SHAPED CRYPTO IS REFUSED AT THE WRITE (S1-S5). A 16-byte GCM nonce or
-- a truncated tag means the implementation is wrong. Catching it at the INSERT
-- makes it a failing test; catching it nowhere makes it a year of forgeable
-- ciphertexts.
--
-- A REUSED NONCE IS REFUSED (N1-N2). GCM nonce reuse under one key breaks
-- confidentiality *and* authentication. With random 96-bit nonces a real
-- collision is negligible, so the unique index is a canary for a broken
-- implementation — anything that hardcodes an IV hits it on the second row.

BEGIN;
SELECT plan(31);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-5ec0-0000-0000-000000000001', 'member@espiga.test'),
  ('11111111-5ec0-0000-0000-000000000002', 'outsider@other.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-5ec0-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-secret-test'),
  ('aaaaaaaa-5ec0-0000-0000-000000000002', 'Ferretería El Tornillo', 'tornillo-secret-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-5ec0-0000-0000-000000000001', '11111111-5ec0-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-5ec0-0000-0000-000000000002', '11111111-5ec0-0000-0000-000000000002', 'owner');

-- Bytes of the right shape. Not real ciphertext — this file tests the store,
-- not the cipher; `packages/security/src/secret-crypto.test.ts` tests that.
INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
VALUES ('gladia', 'api_key', 'platform.v1',
        '\x000102030405060708090a0b'::bytea,
        '\xdeadbeefcafe'::bytea,
        '\x000102030405060708090a0b0c0d0e0f'::bytea);

INSERT INTO public.organization_secrets
  (organization_id, provider, secret_name, scopes, expires_at, key_id, iv, ciphertext, auth_tag)
VALUES
  ('aaaaaaaa-5ec0-0000-0000-000000000001', 'hubspot', 'access_token',
   ARRAY['crm.objects.contacts.read','crm.objects.contacts.write'],
   pg_catalog.now() + interval '30 days', 'org.v1',
   '\x0102030405060708090a0b0c'::bytea, '\xfeedface'::bytea,
   '\x0102030405060708090a0b0c0d0e0f10'::bytea),
  ('aaaaaaaa-5ec0-0000-0000-000000000001', 'hubspot', 'refresh_token',
   ARRAY[]::text[], NULL, 'org.v1',
   '\x0202030405060708090a0b0c'::bytea, '\xfeedfacf'::bytea,
   '\x0202030405060708090a0b0c0d0e0f10'::bytea);

-- --- S: shape -------------------------------------------------------------

SELECT has_table('public', 'platform_secrets', 'S1: platform_secrets exists');
SELECT has_table('public', 'organization_secrets', 'S2: organization_secrets exists');

SELECT throws_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('bad', 'iv', 'platform.v1', '\x0001'::bytea, '\xaa'::bytea,
            '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  '23514',
  NULL,
  'S3: a short GCM nonce is refused — 96 bits is what the mode is specified '
  'for, and a wrong length means the implementation is wrong'
);

SELECT throws_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('bad', 'tag', 'platform.v1', '\x000102030405060708090a0b'::bytea,
            '\xaa'::bytea, '\x0001'::bytea)$$,
  '23514',
  NULL,
  'S4: a truncated auth tag is refused — truncation weakens forgery resistance, '
  'and doing it accidentally is indistinguishable from doing it on purpose'
);

SELECT throws_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('bad', 'empty', 'platform.v1', '\x000102030405060708090a0b'::bytea,
            ''::bytea, '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  '23514',
  NULL,
  'S5: an empty ciphertext is refused — a row that looks configured and '
  'decrypts to nothing authenticates as nobody'
);

SELECT throws_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('bad', 'keyid', 'Platform V1!', '\x000102030405060708090a0b'::bytea,
            '\xaa'::bytea, '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  '23514',
  NULL,
  'S6: a malformed key_id is refused — it is the handle rotation is performed '
  'by, so it has to be a stable identifier and not free text'
);

-- The positive control for S3-S6. Without it they would all pass against a
-- table that rejected every insert.
SELECT lives_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('langdock', 'api_key', 'platform.v1',
            '\x0a0102030405060708090a0b'::bytea, '\xaabbcc'::bytea,
            '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  'S7: a well-formed row is accepted'
);

SELECT is(
  (SELECT scopes FROM public.organization_secrets
    WHERE provider = 'hubspot' AND secret_name = 'refresh_token'),
  ARRAY[]::text[],
  'S8: scopes defaults to an empty array, not NULL — "no scopes" and "we do '
  'not know the scopes" are different, and a nullable array makes every reader '
  'COALESCE'
);

-- --- N: nonce discipline ---------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('reuse', 'api_key', 'platform.v1',
            '\x000102030405060708090a0b'::bytea, '\xbbbb'::bytea,
            '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  '23505',
  NULL,
  'N1: the same nonce under the same key is refused — GCM nonce reuse breaks '
  'confidentiality AND authentication, and anything that hardcodes an IV hits '
  'this on its second row'
);

SELECT lives_ok(
  $$INSERT INTO public.platform_secrets (provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('reuse', 'api_key', 'platform.v2',
            '\x000102030405060708090a0b'::bytea, '\xbbbb'::bytea,
            '\x000102030405060708090a0b0c0d0e0f'::bytea)$$,
  'N2: the same nonce under a DIFFERENT key is fine — the danger is reuse '
  'within one key, and forbidding it across keys would block rotation'
);

SELECT throws_ok(
  $$INSERT INTO public.organization_secrets
      (organization_id, provider, secret_name, key_id, iv, ciphertext, auth_tag)
    VALUES ('aaaaaaaa-5ec0-0000-0000-000000000001', 'hubspot', 'access_token',
            'org.v1', '\x0f0102030405060708090a0b'::bytea, '\xcc'::bytea,
            '\x0102030405060708090a0b0c0d0e0f10'::bytea)$$,
  '23505',
  NULL,
  'N3: one secret per (organization, provider, name) — two rows for one '
  'credential is a question with two answers at read time'
);

-- --- M: the metadata reader ------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-5ec0-0000-0000-000000000001","role":"authenticated"}', true);

SELECT is(
  (SELECT count(*)::int FROM public.organization_connected_accounts(
     'aaaaaaaa-5ec0-0000-0000-000000000001')),
  2,
  'M1: a member sees their organization''s connected accounts'
);

-- The assertion that matters most in this file. Asserting the exact set means
-- adding a column to that function is a deliberate act with a failing test,
-- not an accident during a later feature.
CREATE TEMP TABLE _cols AS
SELECT * FROM public.organization_connected_accounts('aaaaaaaa-5ec0-0000-0000-000000000001')
LIMIT 0;

SELECT is(
  (SELECT string_agg(column_name, ',' ORDER BY column_name)
     FROM information_schema.columns
    WHERE table_name = '_cols'),
  'created_at,expires_at,is_expired,provider,scopes,secret_name,updated_at',
  'M2: the reader returns metadata ONLY — no ciphertext, no iv, no auth_tag, '
  'and no key_id, which would tell a caller which key to go after'
);

SELECT is(
  (SELECT is_expired FROM public.organization_connected_accounts(
     'aaaaaaaa-5ec0-0000-0000-000000000001') WHERE secret_name = 'access_token'),
  false,
  'M3: a credential expiring in 30 days is not expired'
);

SELECT is(
  (SELECT is_expired FROM public.organization_connected_accounts(
     'aaaaaaaa-5ec0-0000-0000-000000000001') WHERE secret_name = 'refresh_token'),
  false,
  'M4: and one with no expiry is not expired either — NULL must not read as '
  'expired, or every API key in the system reports as dead'
);

SELECT throws_ok(
  $$SELECT * FROM public.organization_connected_accounts(
      'aaaaaaaa-5ec0-0000-0000-000000000002')$$,
  'P3H01',
  NULL,
  'M5: a non-member is refused — this function is the tenancy boundary for the '
  'whole subsystem, because it is the only read path an organization has'
);

SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT * FROM public.organization_connected_accounts(
      'aaaaaaaa-5ec0-0000-0000-000000000001')$$,
  'M6: and it is callable as `authenticated`, which is the point of it existing'
);

SET LOCAL ROLE postgres;

-- Now the same member, expired.
UPDATE public.organization_secrets
SET expires_at = pg_catalog.now() - interval '1 day'
WHERE provider = 'hubspot' AND secret_name = 'access_token';

SELECT is(
  (SELECT is_expired FROM public.organization_connected_accounts(
     'aaaaaaaa-5ec0-0000-0000-000000000001') WHERE secret_name = 'access_token'),
  true,
  'M7: a past expiry reads as expired — the positive control for M3/M4, which '
  'would both pass if is_expired were hardcoded false'
);

-- --- A: access -------------------------------------------------------------

-- ARRAY[] and not ARRAY['SELECT']. There is no read path for the application
-- on these tables at all; the metadata function above is the whole surface.
SELECT table_privs_are('public', 'platform_secrets', 'authenticated', ARRAY[]::text[],
  'A1: authenticated holds NOTHING on platform_secrets — not even SELECT');
SELECT table_privs_are('public', 'organization_secrets', 'authenticated', ARRAY[]::text[],
  'A2: nor on organization_secrets');
SELECT table_privs_are('public', 'platform_secrets', 'anon', ARRAY[]::text[],
  'A3: anon holds nothing on platform_secrets');
SELECT table_privs_are('public', 'organization_secrets', 'anon', ARRAY[]::text[],
  'A4: anon holds nothing on organization_secrets');

-- `table_privs_are` asserts the exact set, so A1-A4 already cover REFERENCES
-- and TRIGGER. This names them because they are the two the narrower
-- `REVOKE INSERT, UPDATE, DELETE` leaves behind, and that narrower form is
-- what dcfe72c had to correct elsewhere in this schema.
--
-- Worth being precise about what this does and does not catch, because
-- mutation testing showed the difference. Replacing the `REVOKE ALL` in the
-- migration with the narrow form ESCAPES every assertion here — and correctly
-- so: these are new tables, `authenticated` was never granted anything on
-- them, and on a table with no grants the two forms are identical. The narrow
-- revoke is only dangerous where a grant already exists, which is exactly the
-- situation dcfe72c found on `organization_invitations`.
--
-- So A5 is not a guard against the revoke being narrowed. It is a guard
-- against a privilege being ADDED, and it does catch that: granting TRIGGER to
-- `authenticated` fails A2 and A5 together.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.organization_secrets', 'TRIGGER')
  AND NOT has_table_privilege('authenticated', 'public.organization_secrets', 'REFERENCES'),
  'A5: specifically not TRIGGER or REFERENCES — TRIGGER on a credential table '
  'lets a role attach a function that fires on every write'
);

SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_class
    WHERE oid IN ('public.platform_secrets'::regclass,
                  'public.organization_secrets'::regclass)
      AND relrowsecurity AND relforcerowsecurity),
  2,
  'A6: both tables have RLS enabled AND forced — without FORCE the owner '
  'bypasses its own policies, and the definer function runs as the owner'
);

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('platform_secrets', 'organization_secrets')),
  0,
  'A7: there are no row policies at all — a policy would imply somebody other '
  'than service_role is meant to read these, and nobody is'
);

SELECT table_privs_are('public', 'organization_secrets', 'service_role',
  ARRAY['SELECT','INSERT','UPDATE','DELETE'],
  'A8: service_role has exactly what it needs and no more — UPDATE is there '
  'for key rotation, DELETE for disconnecting an account');

-- The other half of the same claim, and it was missing.
--
-- A8 covered organization_secrets alone, so when the migration failed to
-- revoke service_role's default ALL, exactly one of the two credential tables
-- reported it. The tables are created by the same migration with the same
-- intent, and an assertion that covers one of a pair is how the other one
-- drifts — this file already makes that argument about anon and authenticated
-- in A1-A4, which do cover both.
SELECT table_privs_are('public', 'platform_secrets', 'service_role',
  ARRAY['SELECT','INSERT','UPDATE','DELETE'],
  'A8b: ...and the same on platform_secrets, which A8 alone did not cover');

-- --- D: lifecycle ----------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM public.organization_secrets
    WHERE organization_id = 'aaaaaaaa-5ec0-0000-0000-000000000002'),
  0,
  'D1: an organization with no connected accounts has none'
);

-- Organizations are soft-deleted (trigger_soft_delete_organizations), so the
-- ON DELETE CASCADE here never fires in practice. Asserted so the next reader
-- does not assume a hard delete revokes a customer's stored credentials — it
-- does not, and offboarding has to delete them deliberately.
SELECT lives_ok(
  $$DELETE FROM public.organizations WHERE id = 'aaaaaaaa-5ec0-0000-0000-000000000001'$$,
  'D2: deleting an organization is accepted — and soft-deleted'
);

SELECT is(
  (SELECT count(*)::int FROM public.organization_secrets
    WHERE organization_id = 'aaaaaaaa-5ec0-0000-0000-000000000001'),
  2,
  'D3: its credentials SURVIVE, because the delete was soft. Offboarding must '
  'remove them explicitly; nothing here does it for you'
);

SELECT lives_ok(
  $$DELETE FROM public.organization_secrets
     WHERE organization_id = 'aaaaaaaa-5ec0-0000-0000-000000000001'$$,
  'D4: and service_role can, which is what offboarding will use'
);

SELECT * FROM finish();
ROLLBACK;
