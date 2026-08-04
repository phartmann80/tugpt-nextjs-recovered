-- Phase 3A: PGMQ extension setup
-- Migration: 20260804000008_setup_pgmq.sql

-- Create the pgmq extension
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Create the whatsapp_inbound queue
SELECT pgmq.create('whatsapp_inbound');

-- Grant service_role access to the pgmq schema
GRANT USAGE ON SCHEMA pgmq TO service_role;

-- Revoke access from PUBLIC, anon, and authenticated
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, anon, authenticated;

-- Revoke table-level access from non-service roles
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC, anon, authenticated;