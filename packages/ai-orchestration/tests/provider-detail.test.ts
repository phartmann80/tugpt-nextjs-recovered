/**
 * @file provider-detail.test.ts
 * @description Tests for sanitized provider-error capture, added 2026-08-19.
 *
 * Context: Langdock rejected `model: "auto"` with an HTTP 400 whose body said
 * exactly what was wrong ("Invalid model, available models are: ..."), but
 * nothing in TuGPT captured it, so the failure was only diagnosable by calling
 * the API by hand. These tests pin the two properties that fix must have:
 * the provider's own complaint survives, and nothing else does.
 */
import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  sanitizeProviderDetail,
  extractProviderDetail,
  PROVIDER_DETAIL_MAX_LENGTH,
} from '@tugpt/ai-providers';

/** The real body Langdock returned on 2026-08-19. */
const REAL_LANGDOCK_400 = JSON.stringify({
  error: {
    message:
      'Invalid model, available models are: gpt-5-mini, gpt-5, o3, gpt-5.1, o4-mini, gpt-5.6-sol, gpt-5.6-terra, gpt-5.4-mini, gpt-5.4, gpt-5.6-luna, gpt-5.5, gpt-5.2-pro, langdock-llama-3.3-70b-2, gpt-5.2',
    type: 'invalid_request_error',
  },
});

describe('extractProviderDetail', () => {
  it('extracts the message and type from the real Langdock 400 body', () => {
    const detail = extractProviderDetail(REAL_LANGDOCK_400);
    expect(detail).toContain('invalid_request_error');
    expect(detail).toContain('Invalid model');
  });

  it('handles a flat { message } envelope', () => {
    expect(extractProviderDetail(JSON.stringify({ message: 'rate limited' }))).toBe('rate limited');
  });

  it('uses code as the qualifier when type is absent', () => {
    const detail = extractProviderDetail(
      JSON.stringify({ error: { message: 'nope', code: 'context_length_exceeded' } })
    );
    expect(detail).toBe('context_length_exceeded: nope');
  });

  it('returns undefined for a non-JSON body rather than storing it', () => {
    // An HTML error page must never be persisted, and neither must anything
    // else we cannot prove is the provider's own structured error.
    expect(extractProviderDetail('<html><body>502 Bad Gateway</body></html>')).toBeUndefined();
  });

  it('returns undefined for JSON with no recognisable error fields', () => {
    expect(extractProviderDetail(JSON.stringify({ choices: [] }))).toBeUndefined();
    expect(extractProviderDetail(JSON.stringify({ error: {} }))).toBeUndefined();
  });

  it('returns undefined for empty or missing input', () => {
    expect(extractProviderDetail('')).toBeUndefined();
    expect(extractProviderDetail(null)).toBeUndefined();
    expect(extractProviderDetail(undefined)).toBeUndefined();
  });

  it('ignores non-string message fields instead of coercing them', () => {
    expect(extractProviderDetail(JSON.stringify({ error: { message: { nested: 1 } } }))).toBeUndefined();
  });

  it('does not return a whole echoed request body', () => {
    // If a provider echoes our request, only its error fields are read.
    const echoed = JSON.stringify({
      error: { message: 'bad request', type: 'invalid_request_error' },
      request: { messages: [{ role: 'user', content: 'CUSTOMER SECRET TEXT' }] },
    });
    const detail = extractProviderDetail(echoed);
    expect(detail).not.toContain('CUSTOMER SECRET TEXT');
  });
});

describe('sanitizeProviderDetail', () => {
  it('redacts bearer tokens', () => {
    const out = sanitizeProviderDetail('failed with Authorization: Bearer sk-abc123def456ghi789');
    expect(out).not.toContain('sk-abc123def456ghi789');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts api-key-shaped substrings', () => {
    const out = sanitizeProviderDetail('key ld-9f8e7d6c5b4a3210 rejected');
    expect(out).not.toContain('ld-9f8e7d6c5b4a3210');
    expect(out).toContain('[REDACTED_KEY]');
  });

  it('redacts JWT-shaped substrings', () => {
    const out = sanitizeProviderDetail('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 expired');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED_JWT]');
  });

  it('collapses newlines so the value stays one log line', () => {
    expect(sanitizeProviderDetail('line one\nline two\r\n  line three')).toBe('line one line two line three');
  });

  it('truncates to the documented maximum', () => {
    const out = sanitizeProviderDetail('x'.repeat(1000));
    expect(out).toBeDefined();
    expect((out as string).length).toBe(PROVIDER_DETAIL_MAX_LENGTH);
    expect(out).toMatch(/\.\.\.$/);
  });

  it('returns undefined for empty or whitespace-only input', () => {
    expect(sanitizeProviderDetail('')).toBeUndefined();
    expect(sanitizeProviderDetail('   ')).toBeUndefined();
    expect(sanitizeProviderDetail(null)).toBeUndefined();
  });
});

describe('ProviderError carries sanitized detail', () => {
  it('sanitizes detail passed to the constructor', () => {
    const err = new ProviderError('langdock', 'HTTP_400', 400, 'Bearer sk-shouldnotsurvive1234');
    expect(err.providerDetail).not.toContain('sk-shouldnotsurvive1234');
  });

  it('threads detail through fromHttpStatus for a 400', () => {
    const err = ProviderError.fromHttpStatus('langdock', 400, extractProviderDetail(REAL_LANGDOCK_400));
    expect(err.category).toBe('HTTP_400');
    expect(err.httpStatus).toBe(400);
    expect(err.providerDetail).toContain('Invalid model');
  });

  it('leaves detail undefined when the provider gave nothing usable', () => {
    expect(ProviderError.fromHttpStatus('langdock', 500).providerDetail).toBeUndefined();
  });

  it('keeps message as the category only, never the detail', () => {
    const err = new ProviderError('langdock', 'HTTP_400', 400, 'something the provider said');
    expect(err.message).toBe('HTTP_400');
  });
});
