#!/bin/bash
# Database reset script for local PostgreSQL testing (non-Docker)
set -e
DB_NAME="tugpt_test"
PSQL="sudo -u postgres psql"

echo "=== Dropping database $DB_NAME ==="
$PSQL -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true

echo "=== Creating database $DB_NAME ==="
$PSQL -c "CREATE DATABASE $DB_NAME;"

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
