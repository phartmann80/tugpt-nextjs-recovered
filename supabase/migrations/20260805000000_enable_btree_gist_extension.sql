-- Phase 3B: Enable btree_gist extension
-- Migration: 20260805000000_enable_btree_gist_extension.sql
-- Must run BEFORE the draft_quota_limits table (migration 00004) which uses
-- an EXCLUDE USING gist constraint for period overlap prevention.

CREATE EXTENSION IF NOT EXISTS btree_gist;