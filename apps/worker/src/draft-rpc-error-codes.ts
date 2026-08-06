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
 *   DRAFT_PROVIDER_OUTPUT_TOO_LONG, DRAFT_INVALID_CONFIG,
 *   DRAFT_PROVIDER_ERROR, DRAFT_GENERATION_TIMEOUT,
 *   DRAFT_QUOTA_EXCEEDED, DRAFT_INTERNAL_ERROR
 */

import type { ProviderErrorCategory } from '@tugpt/ai-providers';

/** Normalized error codes for the draft worker. */
export type DraftErrorCode =
  | 'DRAFT_PROVIDER_AUTH_ERROR'
  | 'DRAFT_PROVIDER_CONFIG_ERROR'
  | 'DRAFT_MALFORMED_RESPONSE'
  | 'DRAFT_EXHAUSTED_RETRIES'
  | 'DRAFT_INVALID_REQUEST'
  | 'DRAFT_PROVIDER_EMPTY_OUTPUT'
  | 'DRAFT_PROVIDER_OUTPUT_TOO_LONG'
  | 'DRAFT_INVALID_CONFIG'
  | 'DRAFT_PROVIDER_ERROR'
  | 'DRAFT_GENERATION_TIMEOUT'
  | 'DRAFT_QUOTA_EXCEEDED'
  | 'DRAFT_INTERNAL_ERROR';

/**
 * Map a ProviderErrorCategory to the approved database error code.
 *
 * Per Paul's amendment #5: use the existing approved error-code registry,
 * not invented codes. Quota denial is an entitlement outcome, not a
 * provider failure — it terminates through the skip/denial path.
 */
export function mapProviderErrorToDbCode(category: ProviderErrorCategory): DraftErrorCode {
  switch (category) {
    case 'HTTP_401':
    case 'HTTP_403':
      return 'DRAFT_PROVIDER_AUTH_ERROR';

    case 'INVALID_CONFIGURATION':
      return 'DRAFT_PROVIDER_CONFIG_ERROR';

    case 'HTTP_400':
    case 'HTTP_404':
    case 'HTTP_422':
    case 'INVALID_REQUEST':
      return 'DRAFT_INVALID_REQUEST';

    case 'MALFORMED_PROVIDER_RESPONSE':
      return 'DRAFT_MALFORMED_RESPONSE';

    case 'EMPTY_OUTPUT':
      return 'DRAFT_PROVIDER_EMPTY_OUTPUT';

    case 'OUTPUT_TOO_LONG':
      return 'DRAFT_PROVIDER_OUTPUT_TOO_LONG';

    case 'TIMEOUT':
      return 'DRAFT_GENERATION_TIMEOUT';

    // Transient failures that exhausted retries
    case 'NETWORK_FAILURE':
    case 'HTTP_408':
    case 'HTTP_429':
    case 'HTTP_5XX':
      return 'DRAFT_PROVIDER_ERROR';

    default:
      return 'DRAFT_INTERNAL_ERROR';
  }
}

/**
 * Map a SQLSTATE code from draft RPCs to a normalized worker error code.
 * Returns DRAFT_INTERNAL_ERROR for any unknown or missing code.
 */
const SQLSTATE_TO_DRAFT: Readonly<Record<string, DraftErrorCode>> = {
  P3B07: 'DRAFT_INTERNAL_ERROR',      // DRAFT_JOB_NOT_FOUND
  P3B08: 'DRAFT_INTERNAL_ERROR',      // DRAFT_JOB_IDENTITY_MISMATCH
  P3B10: 'DRAFT_INTERNAL_ERROR',      // INVALID_DRAFT_JOB_STATE
  P3B11: 'DRAFT_INTERNAL_ERROR',      // QUOTA_RESERVATION_STATE_ERROR
  P3B12: 'DRAFT_INTERNAL_ERROR',      // DRAFT_ARCHIVE_STATE_ERROR
  P3B14: 'DRAFT_INTERNAL_ERROR',      // DRAFT_TENANT_MISMATCH
  P3B15: 'DRAFT_INTERNAL_ERROR',      // INVALID_DRAFT_FAILURE_CODE
  P3B16: 'DRAFT_INTERNAL_ERROR',      // INVALID_DRAFT_ATTEMPTS
  '90006': 'DRAFT_INTERNAL_ERROR',    // ARCHIVE_FAILED
  '90007': 'DRAFT_INTERNAL_ERROR',    // INVALID_VISIBILITY_TIMEOUT
};

export function normalizeDraftRpcErrorCode(code: string | undefined | null): DraftErrorCode {
  if (code && code in SQLSTATE_TO_DRAFT) {
    return SQLSTATE_TO_DRAFT[code];
  }
  return 'DRAFT_INTERNAL_ERROR';
}