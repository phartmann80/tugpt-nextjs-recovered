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