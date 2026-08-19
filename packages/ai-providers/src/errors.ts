/**
 * @file errors.ts
 * @description Structured provider error types for TuGPT.ai.
 *
 * These errors carry a normalized category, HTTP status (when applicable),
 * and provider name. They never carry credentials, prompts, or customer
 * content.
 *
 * As of 2026-08-19 they may additionally carry `providerDetail`: a short,
 * sanitized description of *the provider's own* complaint. This was added
 * after a Langdock 400 ("Invalid model, available models are: ...") was
 * diagnosable only by curling the API by hand from the server, because
 * nothing in the dead-letter record said what the provider had actually
 * objected to.
 *
 * `providerDetail` is deliberately narrow. It is NOT the response body. It
 * is extracted from the provider's structured error envelope (`error.message`
 * / `error.type`) and then sanitized and truncated, so it cannot become a
 * channel for echoing our own prompt or the customer's message back into the
 * database. See `sanitizeProviderDetail` and `extractProviderDetail`.
 *
 * The orchestration package may import these types to classify errors and
 * decide fallback, but ai-providers must NOT depend on ai-orchestration
 * (no circular dependency).
 */

/** Normalized error categories for provider failures. */
export type ProviderErrorCategory =
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'HTTP_408'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'HTTP_400'
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_422'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'EMPTY_OUTPUT'
  | 'OUTPUT_TOO_LONG'
  | 'UNKNOWN_FAILURE';

/** Hard ceiling on a stored provider detail, in characters. */
export const PROVIDER_DETAIL_MAX_LENGTH = 300;

/**
 * Patterns that must never survive into a stored detail string, even though
 * the extraction path already limits us to the provider's own error text.
 * Defense in depth: a provider could echo an Authorization header back.
 */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\b(sk|pk|ld|api)[-_][A-Za-z0-9._-]{8,}/gi, '[REDACTED_KEY]'],
  [/\beyJ[A-Za-z0-9._-]{16,}/g, '[REDACTED_JWT]'],
];

/**
 * Make a provider-supplied string safe to persist: redact anything
 * credential-shaped, collapse whitespace, and truncate.
 *
 * @returns the sanitized string, or undefined when nothing usable remains.
 */
export function sanitizeProviderDetail(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;

  let out = String(raw);
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  // Collapse all whitespace (including newlines) into single spaces so the
  // value stays a single readable line in logs and in the database.
  out = out.replace(/\s+/g, ' ').trim();

  if (out.length === 0) return undefined;
  if (out.length > PROVIDER_DETAIL_MAX_LENGTH) {
    return `${out.slice(0, PROVIDER_DETAIL_MAX_LENGTH - 3)}...`;
  }
  return out;
}

/**
 * Pull a short description out of a provider's error response.
 *
 * Only the provider's own structured error fields are read — never the whole
 * body — so our prompt or the customer's message can never be echoed into
 * storage even if the provider includes them in its response.
 *
 * Handles the OpenAI-compatible envelope used by Langdock:
 *   { "error": { "message": "...", "type": "..." } }
 * and the flatter `{ "message": "..." }` some gateways return.
 *
 * @param body Raw response text. Parsed defensively; unparseable input yields undefined.
 */
export function extractProviderDetail(body: string | undefined | null): string | undefined {
  if (!body) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON. Do not store an arbitrary body — it could be an HTML error
    // page or, worse, an echo of the request.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const root = parsed as Record<string, unknown>;
  const errorNode =
    typeof root.error === 'object' && root.error !== null
      ? (root.error as Record<string, unknown>)
      : root;

  const message = typeof errorNode.message === 'string' ? errorNode.message : undefined;
  const type = typeof errorNode.type === 'string' ? errorNode.type : undefined;
  const code = typeof errorNode.code === 'string' ? errorNode.code : undefined;

  if (!message && !type && !code) return undefined;

  const qualifier = type ?? code;
  const combined = message
    ? qualifier
      ? `${qualifier}: ${message}`
      : message
    : (qualifier as string);

  return sanitizeProviderDetail(combined);
}

/**
 * Structured provider error.
 *
 * Carries the normalized category, HTTP status (when applicable), the
 * provider name, and optionally a sanitized `providerDetail`. The `message`
 * field is the category string only.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly category: ProviderErrorCategory;
  readonly httpStatus?: number;
  /**
   * Short, sanitized description of the provider's own complaint. Safe to
   * persist and log. Undefined when the provider gave nothing usable.
   */
  readonly providerDetail?: string;

  constructor(
    provider: string,
    category: ProviderErrorCategory,
    httpStatus?: number,
    providerDetail?: string
  ) {
    super(category);
    this.name = 'ProviderError';
    this.provider = provider;
    this.category = category;
    this.httpStatus = httpStatus;
    this.providerDetail = sanitizeProviderDetail(providerDetail);
  }

  /**
   * Create a ProviderError from an HTTP status code.
   * Maps known status codes to their normalized category.
   * Unknown status codes map to UNKNOWN_FAILURE.
   *
   * @param providerDetail Optional sanitized detail, typically from
   * `extractProviderDetail(await response.text())`.
   */
  static fromHttpStatus(
    provider: string,
    status: number,
    providerDetail?: string
  ): ProviderError {
    switch (status) {
      case 400: return new ProviderError(provider, 'HTTP_400', status, providerDetail);
      case 401: return new ProviderError(provider, 'HTTP_401', status, providerDetail);
      case 403: return new ProviderError(provider, 'HTTP_403', status, providerDetail);
      case 404: return new ProviderError(provider, 'HTTP_404', status, providerDetail);
      case 408: return new ProviderError(provider, 'HTTP_408', status, providerDetail);
      case 422: return new ProviderError(provider, 'HTTP_422', status, providerDetail);
      case 429: return new ProviderError(provider, 'HTTP_429', status, providerDetail);
      default:
        if (status >= 500 && status <= 599) {
          return new ProviderError(provider, 'HTTP_5XX', status, providerDetail);
        }
        return new ProviderError(provider, 'UNKNOWN_FAILURE', status, providerDetail);
    }
  }
}
