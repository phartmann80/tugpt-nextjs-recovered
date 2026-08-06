-- Phase 3B: Create the draft_generation PGMQ queue
-- Migration: 20260805000010_create_draft_generation_queue.sql

-- Create the draft_generation queue
SELECT pgmq.create('draft_generation');

-- Grant service_role access to the pgmq schema (already granted in migration 20260804000008,
-- but re-grant to be safe)
GRANT USAGE ON SCHEMA pgmq TO service_role;