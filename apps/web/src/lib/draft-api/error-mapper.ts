// Stage 5A: SQLSTATE-to-HTTP error mapping with sanitized messages
// Maps database RPC error codes to HTTP status codes and stable application messages.
// Raw database errors are NEVER exposed to the client.

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const ERROR_MAP: Record<string, MappedError> = {
  P3B01: { status: 404, code: 'DRAFT_NOT_FOUND', message: 'Draft not found' },
  P3B02: { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  P3B03: { status: 409, code: 'STALE_VERSION', message: 'This draft has been modified by another reviewer. Please reload and try again.' },
  P3B04: { status: 422, code: 'INVALID_STATE_TRANSITION', message: 'This draft cannot be modified in its current state' },
  P3B05: { status: 422, code: 'INVALID_BODY', message: 'The draft body must not be empty' },
};

const UNKNOWN_ERROR: MappedError = {
  status: 500,
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred',
};

/**
 * Every `code` this module can put on the wire.
 *
 * Exported so `apps/web/src/i18n/dictionaries.test.ts` can assert the
 * dictionaries have a translation for each one. Without that, adding a SQLSTATE
 * here ships an English sentence into a Spanish dashboard and nothing fails.
 */
export function knownDraftErrorCodes(): string[] {
  return Array.from(
    new Set([...Object.values(ERROR_MAP).map((e) => e.code), UNKNOWN_ERROR.code])
  );
}

/**
 * Map a Supabase RPC error to an HTTP status code and sanitized message.
 * Inspects the error's `code` field for SQLSTATE codes (P3B01-P3B05).
 * Unknown errors default to HTTP 500 with a generic message.
 */
export function mapDraftRpcError(error: unknown): MappedError {
  if (!error) return UNKNOWN_ERROR;

  const err = error as { code?: string };
  const sqlstate = err?.code;

  if (sqlstate && ERROR_MAP[sqlstate]) {
    return ERROR_MAP[sqlstate];
  }

  return UNKNOWN_ERROR;
}
