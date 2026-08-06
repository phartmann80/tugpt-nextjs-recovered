import { describe, it, expect } from 'vitest';
import { shouldFallback } from '../src/fallback-matrix';

describe('fallback-matrix', () => {
  // T14: HTTP 408 → FALLBACK_ALLOWED
  it('allows fallback for HTTP_408', () => {
    expect(shouldFallback('HTTP_408')).toBe('FALLBACK_ALLOWED');
  });

  // T15: HTTP 429 → FALLBACK_ALLOWED
  it('allows fallback for HTTP_429', () => {
    expect(shouldFallback('HTTP_429')).toBe('FALLBACK_ALLOWED');
  });

  // T16: HTTP 500 (HTTP_5XX) → FALLBACK_ALLOWED
  it('allows fallback for HTTP_5XX', () => {
    expect(shouldFallback('HTTP_5XX')).toBe('FALLBACK_ALLOWED');
  });

  // T17: Network failure → FALLBACK_ALLOWED
  it('allows fallback for NETWORK_FAILURE', () => {
    expect(shouldFallback('NETWORK_FAILURE')).toBe('FALLBACK_ALLOWED');
  });

  // T18: Timeout → FALLBACK_ALLOWED
  it('allows fallback for TIMEOUT', () => {
    expect(shouldFallback('TIMEOUT')).toBe('FALLBACK_ALLOWED');
  });

  // T19: HTTP 400 → FALLBACK_PROHIBITED
  it('prohibits fallback for HTTP_400', () => {
    expect(shouldFallback('HTTP_400')).toBe('FALLBACK_PROHIBITED');
  });

  // T20: HTTP 401 → FALLBACK_PROHIBITED
  it('prohibits fallback for HTTP_401', () => {
    expect(shouldFallback('HTTP_401')).toBe('FALLBACK_PROHIBITED');
  });

  // T21: HTTP 403 → FALLBACK_PROHIBITED
  it('prohibits fallback for HTTP_403', () => {
    expect(shouldFallback('HTTP_403')).toBe('FALLBACK_PROHIBITED');
  });

  // T22: HTTP 404 → FALLBACK_PROHIBITED
  it('prohibits fallback for HTTP_404', () => {
    expect(shouldFallback('HTTP_404')).toBe('FALLBACK_PROHIBITED');
  });

  // T23: HTTP 422 → FALLBACK_PROHIBITED
  it('prohibits fallback for HTTP_422', () => {
    expect(shouldFallback('HTTP_422')).toBe('FALLBACK_PROHIBITED');
  });

  // T24: Invalid configuration → FALLBACK_PROHIBITED
  it('prohibits fallback for INVALID_CONFIGURATION', () => {
    expect(shouldFallback('INVALID_CONFIGURATION')).toBe('FALLBACK_PROHIBITED');
  });

  // T25: Invalid request → FALLBACK_PROHIBITED
  it('prohibits fallback for INVALID_REQUEST', () => {
    expect(shouldFallback('INVALID_REQUEST')).toBe('FALLBACK_PROHIBITED');
  });

  // T26: Malformed provider response → FALLBACK_PROHIBITED
  it('prohibits fallback for MALFORMED_PROVIDER_RESPONSE', () => {
    expect(shouldFallback('MALFORMED_PROVIDER_RESPONSE')).toBe('FALLBACK_PROHIBITED');
  });

  // T27: Empty output → FALLBACK_PROHIBITED
  it('prohibits fallback for EMPTY_OUTPUT', () => {
    expect(shouldFallback('EMPTY_OUTPUT')).toBe('FALLBACK_PROHIBITED');
  });

  // T28: Output too long → FALLBACK_PROHIBITED
  it('prohibits fallback for OUTPUT_TOO_LONG', () => {
    expect(shouldFallback('OUTPUT_TOO_LONG')).toBe('FALLBACK_PROHIBITED');
  });

  // T29: Unknown failure → FALLBACK_PROHIBITED
  it('prohibits fallback for UNKNOWN_FAILURE', () => {
    expect(shouldFallback('UNKNOWN_FAILURE')).toBe('FALLBACK_PROHIBITED');
  });
});