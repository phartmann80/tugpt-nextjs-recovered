-- Encrypted secret storage.
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
--
-- TuGPT has nowhere to put a credential. Roadmap §3-G: no table can hold a
-- customer's HubSpot token, their own WhatsApp credentials, or a BYO provider
-- key, and ADR-015 D8 asks for "a single per-org connected-accounts store
-- holding encrypted credentials with explicit scopes". Item 23 (marketplace
-- and integrations) is impossible without it.
--
-- It is also where TuGPT's own vendor keys belong. Those live in environment
-- variables today, which is defensible for one or two, and stops being
-- defensible as the list grows: an env var cannot be rotated without a deploy,
-- cannot record when it was last changed, and cannot be scoped.
--
-- ============================================================================
-- THE ENCRYPTION DECISION, AND THE TWO OPTIONS REJECTED
-- ============================================================================
--
-- **The application encrypts. The database stores opaque bytes and holds no
-- key.** Plaintext never appears in a SQL statement.
--
-- pgcrypto is enabled, so the obvious move is `pgp_sym_encrypt` in the
-- database. Two ways to do that, both worse:
--
--   1. **Key stored in the database.** This is not encryption. The key sits
--      beside the ciphertext, so anything that reads one reads the other — a
--      dump, a replica, a backup, a compromised `service_role`. It converts a
--      credential leak into a credential leak with extra steps.
--
--   2. **Key passed as a SQL parameter** from the application. Better, and
--      still wrong: the key and the plaintext both become statement text. They
--      land in `pg_stat_activity` for the duration of the call, in
--      `log_min_duration_statement` output if a slow query trips it, and in
--      `auto_explain`. None of those are places anyone audits for key
--      material, and all of them are places a support engineer pastes into a
--      ticket.
--
-- Encrypting in the application means the only thing that crosses the wire is
-- ciphertext, and a full database dump is inert without a key that was never
-- in the database to begin with. The cost is that the crypto is TypeScript
-- rather than a vendor's C — which is why it is one small module in
-- `@tugpt/security` with the awkward cases tested, rather than spread across
-- call sites.
--
-- ============================================================================
-- TWO TABLES, NOT ONE WITH A NULLABLE organization_id
-- ============================================================================
--
-- A platform secret (TuGPT's Gladia key) and an organization secret (a
-- customer's HubSpot token) are the same shape and a completely different
-- tenancy story. Modelled as one table with a nullable `organization_id`
-- meaning "platform", every future query has to remember that NULL is a
-- special value, and an RLS policy of the usual form —
-- `private.is_org_member(organization_id, auth.uid())` — evaluates to NULL for
-- those rows and excludes them by accident rather than by intent. Security
-- that works by accident works until someone writes the policy the other way
-- round.
--
-- Two tables make the difference structural: a query against one cannot
-- silently return rows of the other, and the grants say what they mean.

-- ---------------------------------------------------------------------------
-- 1. Platform secrets — TuGPT's own vendor credentials
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_secrets (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),

  -- 'gladia', 'langdock', 'meta'. Free text rather than a vocabulary table:
  -- unlike an entitlement metric, a typo here fails loudly at the read (no row
  -- found) instead of silently granting or limiting.
  provider TEXT NOT NULL,

  -- 'api_key', 'webhook_secret'. A provider can have several.
  secret_name TEXT NOT NULL,

  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm'
    CHECK (algorithm IN ('aes-256-gcm')),

  -- WHICH key encrypted this row. Mandatory, and the single most important
  -- column here: without it, rotation is impossible. Re-encrypting under a new
  -- key means finding the rows still on the old one, and a store that cannot
  -- answer "which rows use key X" can never retire X — so the first
  -- compromised key is compromised forever.
  --
  -- Namespaced by design (see the comment on the unique index below).
  key_id TEXT NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),

  iv BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT platform_secrets_ciphertext_nonempty
    CHECK (octet_length(ciphertext) > 0),

  -- Sized per algorithm rather than unconditionally, so adding an algorithm
  -- later is a new branch and not a loosened check. For GCM these are the
  -- standard 96-bit nonce and 128-bit tag; a wrong length means the
  -- implementation is wrong, and it should fail at the write.
  CONSTRAINT platform_secrets_gcm_sizes
    CHECK (algorithm <> 'aes-256-gcm'
           OR (octet_length(iv) = 12 AND octet_length(auth_tag) = 16))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_secrets_provider_name
  ON public.platform_secrets (provider, secret_name);

-- A GCM nonce reused under the same key is catastrophic: it breaks
-- confidentiality AND authentication, and it is the classic way a correct
-- cipher is deployed incorrectly. With 96-bit random nonces a real collision
-- is negligible, so this constraint is not a collision guard — it is a canary
-- for a broken implementation. Anything that hardcodes an IV, or restarts a
-- counter on redeploy, hits it on the second row rather than silently
-- producing forgeable ciphertexts for a year.
--
-- Per-table uniqueness is sufficient because key ids are namespaced by scope
-- (`platform.*` and `org.*`), so one key never encrypts rows in both tables.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_secrets_nonce
  ON public.platform_secrets (key_id, iv);

CREATE TRIGGER trigger_platform_secrets_updated_at
  BEFORE UPDATE ON public.platform_secrets
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.platform_secrets IS
  'TuGPT''s own vendor credentials, encrypted by the application. The database '
  'holds ciphertext and no key.';

-- ---------------------------------------------------------------------------
-- 2. Organization secrets — a customer's connected accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organization_secrets (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  provider TEXT NOT NULL,
  secret_name TEXT NOT NULL,

  -- ADR-015 D8: "encrypted credentials with explicit scopes". Stored so that a
  -- tool binding to a capability can refuse before calling rather than
  -- discovering the permission gap in a 403 mid-conversation.
  --
  -- Empty array, not NULL: "we do not know the scopes" and "it has none" are
  -- different, and a nullable array makes every reader COALESCE.
  scopes TEXT[] NOT NULL DEFAULT '{}',

  -- OAuth tokens expire. Nullable because API keys generally do not, and a
  -- required expiry would have to be invented for them.
  expires_at TIMESTAMPTZ,

  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm'
    CHECK (algorithm IN ('aes-256-gcm')),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),

  iv BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT organization_secrets_ciphertext_nonempty
    CHECK (octet_length(ciphertext) > 0),
  CONSTRAINT organization_secrets_gcm_sizes
    CHECK (algorithm <> 'aes-256-gcm'
           OR (octet_length(iv) = 12 AND octet_length(auth_tag) = 16))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_secrets_org_provider_name
  ON public.organization_secrets (organization_id, provider, secret_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_secrets_nonce
  ON public.organization_secrets (key_id, iv);

CREATE INDEX IF NOT EXISTS idx_org_secrets_expiring
  ON public.organization_secrets (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TRIGGER trigger_organization_secrets_updated_at
  BEFORE UPDATE ON public.organization_secrets
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 3. What an organization may see about its own credentials
-- ---------------------------------------------------------------------------

-- A settings screen has to say "HubSpot — connected, expires in 30 days", so
-- members need *something*. What they must never get is the row: `ciphertext`,
-- `iv`, `auth_tag` and `key_id` are not useful to a customer and are useful to
-- an attacker, and `key_id` in particular tells them which key to go after.
--
-- A function rather than a view with column-level grants, for one reason:
-- column privileges are easy to widen by accident later (`GRANT SELECT ON
-- table` silently supersedes them), whereas this function cannot return a
-- column it does not name. The safe thing should be the structurally
-- unavoidable thing.
CREATE OR REPLACE FUNCTION public.organization_connected_accounts(
  p_organization_id UUID
)
RETURNS TABLE (
  provider TEXT,
  secret_name TEXT,
  scopes TEXT[],
  expires_at TIMESTAMPTZ,
  is_expired BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = 'P3H01';
  END IF;

  RETURN QUERY
  SELECT s.provider,
         s.secret_name,
         s.scopes,
         s.expires_at,
         (s.expires_at IS NOT NULL AND s.expires_at <= pg_catalog.now()),
         s.created_at,
         s.updated_at
  FROM public.organization_secrets s
  WHERE s.organization_id = p_organization_id
  ORDER BY s.provider, s.secret_name;
END;
$$;

COMMENT ON FUNCTION public.organization_connected_accounts(UUID) IS
  'Metadata only — provider, scopes and expiry. Never returns ciphertext, iv, '
  'auth_tag or key_id. Members only (P3H01).';

-- ---------------------------------------------------------------------------
-- 4. Access
-- ---------------------------------------------------------------------------

ALTER TABLE public.platform_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_secrets FORCE ROW LEVEL SECURITY;

-- REVOKE ALL rather than REVOKE INSERT, UPDATE, DELETE, and no re-grant.
--
-- The narrower form leaves REFERENCES and TRIGGER behind — which is exactly
-- what dcfe72c had to correct on `organization_invitations` and `contacts`.
-- On a credential table those are not theoretical: TRIGGER on a table lets a
-- role attach a function that fires on every write, and REFERENCES lets it
-- learn whether a given value exists. Neither role gets anything here, and
-- there is no SELECT to re-grant, because the metadata function above is the
-- only read path an organization has.
--
-- AND service_role IS IN THIS LIST, which it was not when this migration first
-- shipped. That omission is worth writing down rather than quietly correcting,
-- because the reasoning above was already here and was simply applied to the
-- wrong set of roles.
--
-- Supabase's initialisation runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- GRANT ALL ON TABLES TO ... service_role`, so both tables are created with
-- ALL already granted to service_role. A GRANT of the four verbs this backend
-- needs therefore adds nothing and takes nothing away: REFERENCES, TRIGGER and
-- TRUNCATE were present from CREATE TABLE and stayed. Only a REVOKE removes
-- them, and it has to come before the GRANT.
--
-- What that left on a credential table: TRUNCATE, so one statement destroys
-- every organization's stored credentials; and TRIGGER, so a compromised
-- service key can attach a function that fires on every write to this table —
-- with the plaintext in hand, before the ciphertext is at rest. Encrypting the
-- column and then leaving TRIGGER on it is most of the way to not encrypting
-- it at all.
--
-- `supabase/tests/database/secret_storage.test.sql` A8/A8b assert the exact
-- privilege set for BOTH tables. A8 existed and was correct from the start;
-- it failed on the very first CI run of this branch and every run after it.
REVOKE ALL ON public.platform_secrets FROM PUBLIC, authenticated, anon, service_role;
REVOKE ALL ON public.organization_secrets FROM PUBLIC, authenticated, anon, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_secrets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_secrets TO service_role;

REVOKE ALL ON FUNCTION public.organization_connected_accounts(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organization_connected_accounts(UUID)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. What this does not do
-- ---------------------------------------------------------------------------
--
-- **No rows are seeded, and no key is named here.** Key material reaches the
-- application from its environment and never appears in a migration, a seed
-- file, or this comment.
--
-- **No access log.** Recording every read of a credential is worth having and
-- costs a write on every read, which is a decision about the ingest path's
-- budget rather than about this table. `updated_at` already answers "when did
-- this last change"; "who read it, when" is a separate table when someone
-- needs it, and `key_id` means the rows written before it existed are still
-- interpretable.
--
-- **No rotation job.** The schema makes rotation possible — `key_id` is what
-- makes "find everything still on the old key" a query — but performing it is
-- an operational procedure with its own runbook, not a migration.
