/**
 * @file errors.test.ts
 * @description Tests for the sanitizer that stands between a provider's
 * response and the database.
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS
 *
 * `providerDetail` exists because a Langdock 400 was once diagnosable only by
 * curling the API by hand from the server. It is written into dead-letter
 * records and logs — durable places, read by people who are not thinking about
 * secrets when they read them. So this module has one job that is about
 * correctness (classify a status) and one that is about safety (never persist
 * a credential or a customer's words), and the second is the one worth
 * hammering.
 *
 * The redaction patterns are defence in depth: the extraction path already
 * limits us to the provider's own structured error fields. Both layers are
 * tested independently, because "the other layer would have caught it" is how
 * both layers end up not catching it.
 */

import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  PROVIDER_DETAIL_MAX_LENGTH,
  extractProviderDetail,
  sanitizeProviderDetail,
} from './errors';

describe('sanitizeProviderDetail', () => {
  it('returns undefined for nothing', () => {
    expect(sanitizeProviderDetail(undefined)).toBeUndefined();
    expect(sanitizeProviderDetail(null)).toBeUndefined();
    expect(sanitizeProviderDetail('')).toBeUndefined();
  });

  it('returns undefined for whitespace, rather than an empty string', () => {
    // A stored '' would read as "the provider said nothing" where undefined
    // reads as "there was nothing to store". Only one of those is true here.
    expect(sanitizeProviderDetail('   \n\t  ')).toBeUndefined();
  });

  it('redacts a bearer token', () => {
    const out = sanitizeProviderDetail('rejected: Authorization Bearer abc123XYZ._~+/-def= was invalid');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc123XYZ');
  });

  it('redacts prefixed API keys in any of the known shapes', () => {
    for (const key of ['sk-abcdefgh1234', 'pk_ABCDEFGH1234', 'ld-abcdefgh1234', 'api_abcdefgh1234']) {
      const out = sanitizeProviderDetail(`key ${key} rejected`);
      expect(out, key).toContain('[REDACTED_KEY]');
      expect(out, key).not.toContain('abcdefgh1234'.slice(0, 8));
    }
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const out = sanitizeProviderDetail(`token ${jwt} expired`);
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).not.toContain(jwt);
  });

  it('redacts every occurrence, not just the first', () => {
    // The patterns carry /g; a single-shot replace would leave the second key
    // in the database, which is the same leak with extra steps.
    const out = sanitizeProviderDetail('sk-aaaaaaaa1111 and sk-bbbbbbbb2222');
    expect(out).toBe('[REDACTED_KEY] and [REDACTED_KEY]');
  });

  it('collapses newlines so a stored detail stays one readable line', () => {
    expect(sanitizeProviderDetail('line one\n\tline   two\r\nline three')).toBe(
      'line one line two line three'
    );
  });

  it('truncates at the ceiling and marks that it did', () => {
    const out = sanitizeProviderDetail('x'.repeat(PROVIDER_DETAIL_MAX_LENGTH + 50));
    expect(out).toHaveLength(PROVIDER_DETAIL_MAX_LENGTH);
    expect(out?.endsWith('...')).toBe(true);
  });

  it('leaves a detail exactly at the ceiling alone', () => {
    // The boundary the truncation branch turns on. Off by one here means
    // every maximum-length detail silently loses three characters.
    const out = sanitizeProviderDetail('y'.repeat(PROVIDER_DETAIL_MAX_LENGTH));
    expect(out).toHaveLength(PROVIDER_DETAIL_MAX_LENGTH);
    expect(out?.endsWith('...')).toBe(false);
  });

  it('redacts before truncating', () => {
    // Order matters: truncating first could cut a token in half and store the
    // first 297 characters of it. Padding puts the key past the ceiling.
    const out = sanitizeProviderDetail(`${'p'.repeat(PROVIDER_DETAIL_MAX_LENGTH)} sk-secretsecret1234`);
    expect(out).not.toContain('secretsecret');
  });
});

describe('extractProviderDetail', () => {
  it('reads the OpenAI-compatible envelope Langdock uses', () => {
    const body = JSON.stringify({
      error: { message: 'Invalid model, available models are: gpt-5', type: 'invalid_request_error' },
    });
    expect(extractProviderDetail(body)).toBe(
      'invalid_request_error: Invalid model, available models are: gpt-5'
    );
  });

  it('reads the flat envelope some gateways return', () => {
    expect(extractProviderDetail(JSON.stringify({ message: 'upstream unavailable' }))).toBe(
      'upstream unavailable'
    );
  });

  it('falls back to code when there is no type', () => {
    expect(extractProviderDetail(JSON.stringify({ error: { message: 'nope', code: 'rate_limited' } }))).toBe(
      'rate_limited: nope'
    );
  });

  it('returns the qualifier alone when there is no message', () => {
    expect(extractProviderDetail(JSON.stringify({ error: { type: 'server_error' } }))).toBe('server_error');
  });

  it('refuses a non-JSON body outright', () => {
    // An HTML error page, or — the reason this branch exists — an echo of our
    // own request. Storing an arbitrary body is how a prompt ends up in a
    // dead-letter record.
    expect(extractProviderDetail('<html><body>502 Bad Gateway</body></html>')).toBeUndefined();
    expect(extractProviderDetail('plain text failure')).toBeUndefined();
  });

  it('ignores a JSON body with no error fields', () => {
    expect(extractProviderDetail(JSON.stringify({ choices: [], id: 'x' }))).toBeUndefined();
    expect(extractProviderDetail(JSON.stringify({ error: { unrelated: 1 } }))).toBeUndefined();
  });

  it('ignores JSON that is not an object', () => {
    expect(extractProviderDetail('null')).toBeUndefined();
    expect(extractProviderDetail('"a string"')).toBeUndefined();
    expect(extractProviderDetail('42')).toBeUndefined();
  });

  it('ignores non-string message and type fields', () => {
    // A provider returning { message: { text: ... } } must not stringify into
    // '[object Object]' in a durable record.
    expect(extractProviderDetail(JSON.stringify({ error: { message: { nested: 'x' } } }))).toBeUndefined();
  });

  it('returns undefined for nothing', () => {
    expect(extractProviderDetail(undefined)).toBeUndefined();
    expect(extractProviderDetail(null)).toBeUndefined();
    expect(extractProviderDetail('')).toBeUndefined();
  });

  it('sanitizes what it extracts', () => {
    // The two layers composed. A provider that echoes an Authorization header
    // inside its own error message is exactly the case the redaction patterns
    // are defence in depth for.
    const body = JSON.stringify({ error: { message: 'bad Bearer sk-livesecret9999 supplied' } });
    const out = extractProviderDetail(body);
    expect(out).not.toContain('livesecret9999');
    expect(out).toContain('[REDACTED]');
  });
});

describe('ProviderError', () => {
  it('carries the category as its message and nothing else', () => {
    // Load-bearing: `.message` is the category string by design, so callers
    // asserting on error text are asserting on the category. Tests that match
    // a regex against `.message` expecting the detail are testing nothing —
    // which is how four assertions in gladia.test.ts came to be rewritten.
    const err = new ProviderError('langdock', 'HTTP_429', 429, 'slow down');
    expect(err.message).toBe('HTTP_429');
    expect(err.name).toBe('ProviderError');
    expect(err).toBeInstanceOf(Error);
    expect(err.provider).toBe('langdock');
    expect(err.category).toBe('HTTP_429');
    expect(err.httpStatus).toBe(429);
    expect(err.providerDetail).toBe('slow down');
  });

  it('sanitizes the detail given to its constructor', () => {
    const err = new ProviderError('langdock', 'HTTP_400', 400, 'key sk-abcdefgh1234 rejected');
    expect(err.providerDetail).toBe('key [REDACTED_KEY] rejected');
  });

  it('leaves providerDetail undefined when none is given', () => {
    expect(new ProviderError('langdock', 'TIMEOUT').providerDetail).toBeUndefined();
  });

  describe('fromHttpStatus', () => {
    it.each([
      [400, 'HTTP_400'],
      [401, 'HTTP_401'],
      [403, 'HTTP_403'],
      [404, 'HTTP_404'],
      [408, 'HTTP_408'],
      [422, 'HTTP_422'],
      [429, 'HTTP_429'],
    ] as const)('maps %i to %s', (status, category) => {
      const err = ProviderError.fromHttpStatus('langdock', status);
      expect(err.category).toBe(category);
      expect(err.httpStatus).toBe(status);
    });

    it.each([500, 502, 503, 504, 599])('maps %i to HTTP_5XX', (status) => {
      expect(ProviderError.fromHttpStatus('langdock', status).category).toBe('HTTP_5XX');
    });

    it('does not stretch the 5xx band past its edges', () => {
      // 499 and 600 bracket the `status >= 500 && status <= 599` guard. A
      // widened band would classify a client error as retryable, and the
      // worker retries HTTP_5XX — so this boundary decides whether a
      // permanently broken request is retried until it dead-letters.
      expect(ProviderError.fromHttpStatus('langdock', 499).category).toBe('UNKNOWN_FAILURE');
      expect(ProviderError.fromHttpStatus('langdock', 600).category).toBe('UNKNOWN_FAILURE');
    });

    it('carries the detail through', () => {
      const err = ProviderError.fromHttpStatus('langdock', 400, 'invalid_request_error: no such model');
      expect(err.providerDetail).toBe('invalid_request_error: no such model');
    });
  });
});
