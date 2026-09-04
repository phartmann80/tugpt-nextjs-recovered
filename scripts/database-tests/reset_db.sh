#!/bin/bash
# Database reset script for local PostgreSQL testing (non-Docker).
#
# THIS IS AN APPROXIMATION OF CI, NOT A GATE. See README.md in this directory.
# CI runs `supabase db start` against a real Supabase image; this script hand-
# builds a lookalike. Where the two differ, CI is right.
#
# Two of those differences hid real defects for six pull requests and are
# corrected below -- see "FIDELITY" comments. Both are asserted by
# reset_db.test.sh so they cannot be silently dropped again.
set -e
DB_NAME="tugpt_test"
PSQL="sudo -u postgres psql"

echo "=== Dropping database $DB_NAME ==="
$PSQL -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true

# FIDELITY 1 of 2: COLLATION.
#
# A real Supabase database uses glibc en_US.UTF-8, which ignores punctuation at
# the primary level: 'gpt-5.1' sorts BEFORE 'gpt-5-mini' there and AFTER it
# under C. A test that ORDER BYs such strings passes on a C-collated database
# and fails in CI -- which is exactly what happened to multi_currency P4.
#
# en_US.UTF-8 is not present in every container, so ICU with shifted alternate
# handling is used instead; it reproduces the same ordering (verified against
# real CI output). If neither is available the database is created with the
# cluster default and the script says so, loudly, because the alternative is a
# harness that silently cannot catch this class of bug.
echo "=== Creating database $DB_NAME ==="
if $PSQL -c "CREATE DATABASE $DB_NAME TEMPLATE template0 LOCALE_PROVIDER icu \
      ICU_LOCALE 'en-US-u-ka-shifted' LOCALE 'C' ENCODING 'UTF8';" 2>/dev/null; then
  echo "    collation: ICU en-US-u-ka-shifted (reproduces CI ordering)"
elif $PSQL -c "CREATE DATABASE $DB_NAME TEMPLATE template0 \
      LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' ENCODING 'UTF8';" 2>/dev/null; then
  echo "    collation: glibc en_US.UTF-8 (matches CI)"
else
  $PSQL -c "CREATE DATABASE $DB_NAME;"
  echo "    WARNING: neither ICU nor en_US.UTF-8 available."
  echo "    WARNING: database uses the cluster default collation."
  echo "    WARNING: collation-dependent test failures will NOT be caught here."
fi

echo "=== Installing extensions and roles ==="
$PSQL -d $DB_NAME << 'EOSQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS dblink;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;
GRANT ALL ON SCHEMA pgmq TO service_role;

-- FIDELITY 2 of 2: DEFAULT PRIVILEGES.
--
-- Supabase initialises a project with these, so every table a migration
-- creates starts with ALL granted to these roles. A migration that only GRANTs
-- the subset it wants is therefore a no-op -- REFERENCES, TRIGGER and TRUNCATE
-- are already present and stay there unless something REVOKEs them.
--
-- Without these two statements a migration that forgets the REVOKE looks
-- correct here and is wrong in production. That is not hypothetical: it is how
-- service_role kept TRIGGER and TRUNCATE on the encrypted credential tables
-- through six pull requests while this harness reported green.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE auth.users (
    instance_id UUID,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aud TEXT,
    role TEXT,
    email TEXT NOT NULL UNIQUE,
    encrypted_password TEXT,
    email_confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
    raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
    is_super_admin BOOLEAN DEFAULT false,
    confirmation_token TEXT,
    recovery_token TEXT,
    email_change_token_new TEXT,
    email_change TEXT
);
GRANT SELECT ON auth.users TO service_role, authenticated;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (current_setting('request.jwt.claim.sub', true))::uuid,
    (current_setting('request.jwt.claims', true)::json->>'sub')::uuid,
    NULL::uuid
  )
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    current_setting('request.jwt.claim.role', true),
    current_setting('request.jwt.claims', true)::json->>'role',
    NULL::text
  )
$$;
EOSQL
