-- Phase 3B: Extend failed_jobs error_code CHECK constraint for draft error codes
-- Migration: 20260805000014_extend_failed_jobs_error_code.sql

-- Drop the existing CHECK constraint
ALTER TABLE public.failed_jobs
  DROP CONSTRAINT IF EXISTS failed_jobs_error_code_check;

-- Add the extended CHECK constraint with all Phase 3A + Phase 3B error codes
ALTER TABLE public.failed_jobs
  ADD CONSTRAINT failed_jobs_error_code_check CHECK (
    error_code IN (
      -- Phase 3A error codes
      'INVALID_QUEUE_PAYLOAD', 'RECEIPT_NOT_FOUND', 'STAGING_NOT_FOUND',
      'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND', 'DB_TRANSIENT',
      -- Phase 3B draft error codes (provider/config)
      'DRAFT_PROVIDER_AUTH_ERROR', 'DRAFT_PROVIDER_CONFIG_ERROR',
      'DRAFT_MALFORMED_RESPONSE', 'DRAFT_EXHAUSTED_RETRIES',
      'DRAFT_INVALID_REQUEST', 'DRAFT_PROVIDER_EMPTY_OUTPUT',
      'DRAFT_PROVIDER_OUTPUT_TOO_LONG', 'DRAFT_INVALID_CONFIG',
      -- Phase 3B draft error codes (archive allowlist)
      'DRAFT_PROVIDER_ERROR', 'DRAFT_GENERATION_TIMEOUT',
      'DRAFT_QUOTA_EXCEEDED', 'DRAFT_INTERNAL_ERROR'
    )
  );