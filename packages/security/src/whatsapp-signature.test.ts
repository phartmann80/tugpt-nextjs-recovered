import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature, extractSignature } from './whatsapp-signature';

describe('whatsapp-signature', () => {
  const appSecret = 'test-secret';
  const body = Buffer.from('{"test": "data"}');

  function sign(payload: Buffer, secret: string): string {
    const mac = createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${mac}`;
  }

  // S1: verifySignature returns true for valid HMAC-SHA256
  it('returns true for a valid signature', () => {
    const sig = sign(body, appSecret);
    expect(verifySignature(body, sig, appSecret)).toBe(true);
  });

  // S2: verifySignature returns false for invalid signature
  it('returns false for an invalid signature', () => {
    const sig = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    expect(verifySignature(body, sig, appSecret)).toBe(false);
  });

  // S3: verifySignature uses constant-time comparison (wrong length rejected)
  it('returns false for a signature with wrong length', () => {
    expect(verifySignature(body, 'sha256=abc', appSecret)).toBe(false);
  });

  // S4: verifySignature handles missing signature header
  it('returns false for null signature', () => {
    expect(verifySignature(body, null, appSecret)).toBe(false);
  });

  it('returns false for undefined signature', () => {
    expect(verifySignature(body, undefined, appSecret)).toBe(false);
  });

  it('returns false for empty string signature', () => {
    expect(verifySignature(body, '', appSecret)).toBe(false);
  });

  // S5: Signature without sha256= prefix is rejected
  it('returns false for signature without sha256= prefix', () => {
    const mac = createHmac('sha256', appSecret).update(body).digest('hex');
    expect(verifySignature(body, mac, appSecret)).toBe(false);
  });

  // S6: Wrong secret produces non-matching signature
  it('returns false for wrong secret', () => {
    const sig = sign(body, 'wrong-secret');
    expect(verifySignature(body, sig, appSecret)).toBe(false);
  });

  // S7: Signature with uppercase hex is accepted (normalized to lowercase)
  it('accepts uppercase hex signature', () => {
    const mac = createHmac('sha256', appSecret).update(body).digest('hex');
    const sig = `sha256=${mac.toUpperCase()}`;
    expect(verifySignature(body, sig, appSecret)).toBe(true);
  });

  // S8: Tampered body (different content) fails signature verification
  it('returns false for tampered body with valid signature', () => {
    const sig = sign(body, appSecret);
    const tamperedBody = Buffer.from('{"test": "tampered"}');
    expect(verifySignature(tamperedBody, sig, appSecret)).toBe(false);
  });

  // S9: Empty body with valid signature succeeds
  it('returns true for empty body with valid signature', () => {
    const emptyBody = Buffer.alloc(0);
    const sig = sign(emptyBody, appSecret);
    expect(verifySignature(emptyBody, sig, appSecret)).toBe(true);
  });

  // S10: Large body (1MB) with valid signature succeeds
  it('returns true for large body with valid signature', () => {
    const largeBody = Buffer.alloc(1024 * 1024, 0x41);
    const sig = sign(largeBody, appSecret);
    expect(verifySignature(largeBody, sig, appSecret)).toBe(true);
  });

  // S11-S14: a blank app secret must never verify anything.
  //
  // These are the positive controls for the 2026-08-31 change. Before it, every
  // one of them returned TRUE: the caller passed `process.env.X || ''`, an
  // unconfigured server keyed the HMAC on the empty string, and an attacker who
  // knows the algorithm — it is documented by Meta — could sign any payload.
  // The endpoint was gated only by a feature flag that is off, which is not a
  // security control, and was one flip away from being the whole defence.
  describe('a blank app secret', () => {
    it('rejects a signature computed with the empty secret', () => {
      const sig = sign(body, '');
      expect(verifySignature(body, sig, '')).toBe(false);
    });

    it('rejects a signature computed with a whitespace-only secret', () => {
      // The shape a real misconfiguration takes: a quoted empty value in an env
      // file, or a here-doc that kept its indentation.
      const sig = sign(body, '   ');
      expect(verifySignature(body, sig, '   ')).toBe(false);
    });

    it('rejects even a well-formed signature when the secret is blank', () => {
      // Nothing about the *header* is wrong here — correct prefix, 64 hex
      // characters. The refusal is about the key, and about nothing else.
      const sig = sign(body, appSecret);
      expect(verifySignature(body, sig, '')).toBe(false);
    });

    it('still verifies normally once a real secret is given', () => {
      // The check must refuse blanks without refusing anything else. Without
      // this line the whole suite would pass with `return false` at the top.
      expect(verifySignature(body, sign(body, appSecret), appSecret)).toBe(true);
    });
  });

  // extractSignature tests
  it('extracts signature from headers', () => {
    const headers = new Headers();
    headers.set('x-hub-signature-256', 'sha256=abc123');
    expect(extractSignature(headers)).toBe('sha256=abc123');
  });

  it('returns null when signature header is missing', () => {
    const headers = new Headers();
    expect(extractSignature(headers)).toBeNull();
  });
});