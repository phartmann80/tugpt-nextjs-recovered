/**
 * @file draft-rpc-error-codes.ts
 * @description Maps draft RPC SQLSTATE codes to normalized worker error codes.
 *
 * Classification is based on the stable SQLSTATE code (error.code), never
 * on error.message string matching. The raw error message is never logged
 * or persisted.
 *
 * Approved database error codes (from failed_jobs_error_code_check constraint):
 *   DRAFT_PROVIDER_AUTH_ERROR, DRAFT_PROVIDER_CONFIG_ERROR,
 *   DRAFT_MALFORMED_RESPONSE, DRAFT_EXHAUSTED_RETRIES,
 *   DRAFT_INVALID_REQUEST, DRAFT_PROVIDER_EMPTY_OUTPUT,
 *   DRAFT_PROVIDER_OUTPUT_TOO_LONG, DRAFT_INVALID_CONFIG
 *
 * Transient failure categories (TIMEOUT, NETWORK_FAILURE, HTTP_408,
 * HTTP_429, HTTP_5XX) are retained internally for routing and sanitized
 * logs but are NEVER passed to the archive wrapper. Transient failures
 * at attempts 1 and 2 set visibility without archiving. Attempt 3
 * transient archives with DRAFT_EXHAUSTED_RETRIES.
 */

import type { ProviderErrorCategory } from '@tugpt/ai-providers';

/**
 * Approved database error codes that may be passed to archive_draft_failed_job.
 * These are the only values the worker will ever send to the archive wrapper.
 */
export const APPROVED_ARCHIVE_ERROR_CODES: readonly DraftErrorCode[] = [
  'DRAFT_PROVIDER_AUTH_ERROR',
  'DRAFT_PROVIDER_CONFIG_ERROR',
  'DRAFT_MALFORMED_RESPONSE',
  'DRAFT_EXHAUSTED_RETRIES',
  'DRAFT_INVALID_REQUEST',
  'DRAFT_PROVIDER_EMPTY_OUTPUT',
  'DRAFT_PROVIDER_OUTPUT_TOO_LONG',
  'DRAFT_INVALID_CONFIG',
  'DRAFT_INTERNAL_ERROR',
] as const;

/**
 * Normalized error codes for the draft worker.
 *
 * This list must stay a subset of the allowlist inside
 * `private.archive_draft_failed_job`. It was not, until 2026-08-19: the RPC
 * accepted only five codes while the worker produced eight, so every terminal
 * archive was rejected with P3B15 and the job fell through to the read-side
 * retry-exhaustion path. Migration 20260819000001 aligned them. If you add a
 * code here, add it to that RPC's allowlist and to the failed_jobs CHECK
 * constraint in the same change.
 */
export type DraftErrorCode =
  | 'DRAFT_PROVIDER_AUTH_ERROR'
  | 'DRAFT_PROVIDER_CONFIG_ERROR'
  | 'DRAFT_MALFORMED_RESPONSE'
  | 'DRAFT_EXHAUSTED_RETRIES'
  | 'DRAFT_INVALID_REQUEST'
  | 'DRAFT_PROVIDER_EMPTY_OUTPUT'
  | 'DRAFT_PROVIDER_OUTPUT_TOO_LONG'
  | 'DRAFT_INVALID_CONFIG'
  | 'DRAFT_INTERNAL_ERROR';

/**
 * Categories classified as transient (fallback-eligible).
 * These retry via PGMQ visibility timeout and are never archived
 * until the third attempt exhausts retries.
 */
export function isTransientCategory(category: ProviderErrorCategory): boolean {
  return (
    category === 'NETWORK_FAILURE' ||
    category === 'TIMEOUT' ||
    category === 'HTTP_408' ||
    category === 'HTTP_429' ||
    category === 'HTTP_5XX'
  );
}

/**
 * Map a ProviderErrorCategory to the approved database error code for
 * permanent (non-transient) failures only.
 *
 * Transient categories are handled by the caller via visibility/retry
 * logic and never reach this function for archiving. If a transient
 * category is passed, it maps to DRAFT_EXHAUSTED_RETRIES (the only
 * approved code for exhausted transient retries).
 *
 * Quota denial is an entitlement outcome, not a provider failure;
 * it terminates through the skip/denial path.
 */
export function mapProviderErrorToDbCode(category: ProviderErrorCategory): DraftErrorCode {
  switch (category) {
    // Permanent: provider authentication
    case 'HTTP_401':
    case 'HTTP_403':
      return 'DRAFT_PROVIDER_AUTH_ERROR';

    // Permanent: provider configuration
    case 'INVALID_CONFIGURATION':
      return 'DRAFT_PROVIDER_CONFIG_ERROR';

    // Permanent: invalid request
    case 'HTTP_400':
    case 'HTTP_404':
    case 'HTTP_422':
    case 'INVALID_REQUEST':
      return 'DRAFT_INVALID_REQUEST';

    // Permanent: malformed response
    case 'MALFORMED_PROVIDER_RESPONSE':
      return 'DRAFT_MALFORMED_RESPONSE';

    // Permanent: empty output
    case 'EMPTY_OUTPUT':
      return 'DRAFT_PROVIDER_EMPTY_OUTPUT';

    // Permanent: output too long
    case 'OUTPUT_TOO_LONG':
      return 'DRAFT_PROVIDER_OUTPUT_TOO_LONG';

    // Transient categories: if we reach here for archiving, retries are exhausted
    case 'TIMEOUT':
    case 'NETWORK_FAILURE':
    case 'HTTP_408':
    case 'HTTP_429':
    case 'HTTP_5XX':
      return 'DRAFT_EXHAUSTED_RETRIES';

    // Unknown permanent failure
    default:
      return 'DRAFT_INVALID_REQUEST';
  }
}

/**
 * Map a SQLSTATE code from draft RPCs to a normalized worker error code.
 * Returns DRAFT_INVALID_REQUEST for any unknown or missing code.
 */
const SQLSTATE_TO_DRAFT: Readonly<Record<string, DraftErrorCode>> = {
  P3B07: 'DRAFT_INVALID_REQUEST',      // DRAFT_JOB_NOT_FOUND
  P3B08: 'DRAFT_INVALID_REQUEST',      // DRAFT_JOB_IDENTITY_MISMATCH
  P3B10: 'DRAFT_INVALID_REQUEST',      // INVALID_DRAFT_JOB_STATE
  P3B11: 'DRAFT_INVALID_REQUEST',      // QUOTA_RESERVATION_STATE_ERROR
  P3B12: 'DRAFT_INVALID_REQUEST',      // DRAFT_ARCHIVE_STATE_ERROR
  P3B14: 'DRAFT_INVALID_REQUEST',      // DRAFT_TENANT_MISMATCH
  P3B15: 'DRAFT_INVALID_REQUEST',      // INVALID_DRAFT_FAILURE_CODE
  P3B16: 'DRAFT_INVALID_REQUEST',      // INVALID_DRAFT_ATTEMPTS
  '90006': 'DRAFT_INVALID_REQUEST',    // ARCHIVE_FAILED
  '90007': 'DRAFT_INVALID_REQUEST',    // INVALID_VISIBILITY_TIMEOUT
};

export function normalizeDraftRpcErrorCode(code: string | undefined | null): DraftErrorCode {
  if (code && code in SQLSTATE_TO_DRAFT) {
    return SQLSTATE_TO_DRAFT[code];
  }
  return 'DRAFT_INVALID_REQUEST';
}