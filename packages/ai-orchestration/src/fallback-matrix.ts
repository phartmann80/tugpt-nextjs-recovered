/**
 * @file fallback-matrix.ts
 * @description Fallback decision matrix for provider errors.
 *
 * Classifies ProviderErrorCategory into FALLBACK_ALLOWED or FALLBACK_PROHIBITED
 * based on the approved fallback decision table.
 *
 * Langdock is transient fallback only, not load balancing or round-robin.
 */

import type { ProviderErrorCategory } from '@tugpt/ai-providers';
import type { FallbackDecision } from './types';

/**
 * Determine whether a provider error category is eligible for fallback.
 *
 * Fallback ALLOWED:
 *   NETWORK_FAILURE, TIMEOUT, HTTP_408, HTTP_429, HTTP_5XX
 *
 * Fallback PROHIBITED:
 *   HTTP_400, HTTP_401, HTTP_403, HTTP_404, HTTP_422,
 *   INVALID_CONFIGURATION, INVALID_REQUEST, MALFORMED_PROVIDER_RESPONSE,
 *   EMPTY_OUTPUT, OUTPUT_TOO_LONG, UNKNOWN_FAILURE
 */
export function shouldFallback(category: ProviderErrorCategory): FallbackDecision {
  switch (category) {
    case 'NETWORK_FAILURE':
    case 'TIMEOUT':
    case 'HTTP_408':
    case 'HTTP_429':
    case 'HTTP_5XX':
      return 'FALLBACK_ALLOWED';
    default:
      return 'FALLBACK_PROHIBITED';
  }
}