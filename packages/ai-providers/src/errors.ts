/**
 * @file errors.ts
 * @description Structured provider error types for TuGPT.ai.
 *
 * These errors carry a normalized category, HTTP status (when applicable),
 * provider name, and fallback eligibility — never provider response bodies,
 * credentials, prompts, or customer content.
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

/**
 * Structured provider error.
 *
 * Carries the normalized category, HTTP status (when applicable), and
 * provider name. The `message` field is set to the category string only —
 * it never contains provider response bodies, credentials, prompts, or
 * customer content.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly category: ProviderErrorCategory;
  readonly httpStatus?: number;

  constructor(
    provider: string,
    category: ProviderErrorCategory,
    httpStatus?: number
  ) {
    super(category);
    this.name = 'ProviderError';
    this.provider = provider;
    this.category = category;
    this.httpStatus = httpStatus;
  }

  /**
   * Create a ProviderError from an HTTP status code.
   * Maps known status codes to their normalized category.
   * Unknown status codes map to UNKNOWN_FAILURE.
   */
  static fromHttpStatus(provider: string, status: number): ProviderError {
    switch (status) {
      case 400: return new ProviderError(provider, 'HTTP_400', status);
      case 401: return new ProviderError(provider, 'HTTP_401', status);
      case 403: return new ProviderError(provider, 'HTTP_403', status);
      case 404: return new ProviderError(provider, 'HTTP_404', status);
      case 408: return new ProviderError(provider, 'HTTP_408', status);
      case 422: return new ProviderError(provider, 'HTTP_422', status);
      case 429: return new ProviderError(provider, 'HTTP_429', status);
      default:
        if (status >= 500 && status <= 599) {
          return new ProviderError(provider, 'HTTP_5XX', status);
        }
        return new ProviderError(provider, 'UNKNOWN_FAILURE', status);
    }
  }
}