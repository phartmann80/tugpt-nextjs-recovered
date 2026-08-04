/**
 * Stable typed RPC error code mapping.
 *
 * PostgreSQL RPCs raise exceptions with custom SQLSTATE codes (90001-90007).
 * The Supabase JS client surfaces these as `error.code` (the SQLSTATE).
 * This module maps those stable codes to normalized worker error codes.
 *
 * No classification is done via error.message string matching.
 * The raw error message is never logged or persisted.
 */

/** Normalized error codes used throughout the worker. */
export type NormalizedErrorCode =
  | 'RECEIPT_NOT_FOUND'
  | 'STAGING_NOT_FOUND'
  | 'INVALID_STAGING'
  | 'UNSUPPORTED_MESSAGE_KIND'
  | 'DB_TRANSIENT';

/**
 * Mapping from PostgreSQL SQLSTATE codes (set via USING ERRCODE in RPCs)
 * to normalized worker error codes.
 */
const SQLSTATE_TO_NORMALIZED: Readonly<Record<string, NormalizedErrorCode>> = {
  '90001': 'RECEIPT_NOT_FOUND',
  '90002': 'STAGING_NOT_FOUND',
  '90008': 'INVALID_STAGING',
  '90009': 'UNSUPPORTED_MESSAGE_KIND',
  // 90003: CONNECTION_NOT_FOUND (ingest only, not used by worker)
  // 90004: EVENT_KEY_PAYLOAD_MISMATCH (ingest only, not used by worker)
  // 90005: QUEUE_SEND_FAILED (ingest only, not used by worker)
  // 90006: ARCHIVE_FAILED (dead-letter RPC, handled separately)
  // 90007: INVALID_VISIBILITY_TIMEOUT (queue wrapper, handled separately)
};

/**
 * Map a Supabase RPC error's `code` (SQLSTATE) to a normalized error code.
 * Returns DB_TRANSIENT for any unknown or missing code (conservative default).
 *
 * @param errorCode - The `error.code` field from the Supabase RPC response
 * @returns A stable normalized error code, never null
 */
export function normalizeRpcErrorCode(errorCode: string | undefined | null): NormalizedErrorCode {
  if (errorCode && errorCode in SQLSTATE_TO_NORMALIZED) {
    return SQLSTATE_TO_NORMALIZED[errorCode];
  }
  return 'DB_TRANSIENT';
}