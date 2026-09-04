import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptSecret,
  decryptSecret,
  rotateSecret,
  keyRingFromEnv,
  secretsEqual,
  SecretCryptoError,
  type KeyRing,
  type SecretIdentity,
} from './secret-crypto';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const keys: KeyRing = new Map([
  ['platform.v1', KEY_A],
  ['platform.v2', KEY_B],
]);

const gladia: SecretIdentity = {
  organizationId: null,
  provider: 'gladia',
  secretName: 'api_key',
};
const hubspotEspiga: SecretIdentity = {
  organizationId: 'aaaaaaaa-0000-0000-0000-000000000001',
  provider: 'hubspot',
  secretName: 'access_token',
};
const hubspotTornillo: SecretIdentity = {
  organizationId: 'aaaaaaaa-0000-0000-0000-000000000002',
  provider: 'hubspot',
  secretName: 'access_token',
};

describe('secret-crypto — round trip', () => {
  it('decrypts what it encrypted', () => {
    const sealed = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    expect(decryptSecret(sealed, gladia, keys)).toBe('gladia-live-key');
  });

  it('produces the column shapes the schema constrains', () => {
    const sealed = encryptSecret('x', gladia, 'platform.v1', keys);
    // 20260903000003 CHECKs these lengths; a mismatch here means the migration
    // would reject every row this code writes.
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.algorithm).toBe('aes-256-gcm');
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
  });

  it('handles unicode and long values', () => {
    const secret = 'ñ🔑' + 'a'.repeat(4096);
    const sealed = encryptSecret(secret, gladia, 'platform.v1', keys);
    expect(decryptSecret(sealed, gladia, keys)).toBe(secret);
  });
});

describe('secret-crypto — nonce discipline', () => {
  // GCM nonce reuse under one key breaks confidentiality AND authentication.
  // The function never accepts an IV from its caller, so the only way this can
  // regress is someone adding that parameter — which this notices.
  it('never repeats an IV', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(encryptSecret('same', gladia, 'platform.v1', keys).iv.toString('hex'));
    }
    expect(seen.size).toBe(500);
  });

  it('encrypts the same plaintext to different ciphertext each time', () => {
    const a = encryptSecret('same', gladia, 'platform.v1', keys);
    const b = encryptSecret('same', gladia, 'platform.v1', keys);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe('secret-crypto — the ciphertext is bound to its row', () => {
  // The assertion this module exists for. Without AAD, a blob moved between
  // rows decrypts cleanly and hands one organization another's credential.
  it('refuses a ciphertext read against a different organization', () => {
    const sealed = encryptSecret('espiga-token', hubspotEspiga, 'platform.v1', keys);
    expect(() => decryptSecret(sealed, hubspotTornillo, keys)).toThrow(SecretCryptoError);
    try {
      decryptSecret(sealed, hubspotTornillo, keys);
    } catch (e) {
      expect((e as SecretCryptoError).code).toBe('DECRYPT_FAILED');
    }
  });

  it('refuses a ciphertext read against a different provider', () => {
    const sealed = encryptSecret('t', hubspotEspiga, 'platform.v1', keys);
    expect(() =>
      decryptSecret(sealed, { ...hubspotEspiga, provider: 'salesforce' }, keys)
    ).toThrow(SecretCryptoError);
  });

  it('refuses a ciphertext read against a different secret name', () => {
    const sealed = encryptSecret('t', hubspotEspiga, 'platform.v1', keys);
    expect(() =>
      decryptSecret(sealed, { ...hubspotEspiga, secretName: 'refresh_token' }, keys)
    ).toThrow(SecretCryptoError);
  });

  // The positive control for the three above. Without it they would all pass
  // against an implementation that simply never decrypts anything.
  it('accepts the identity it was encrypted for', () => {
    const sealed = encryptSecret('espiga-token', hubspotEspiga, 'platform.v1', keys);
    expect(decryptSecret(sealed, hubspotEspiga, keys)).toBe('espiga-token');
  });

  // A platform secret has organizationId null. If that were folded into the AAD
  // as the string "null" rather than "", an organization literally named
  // "null" would collide with it — remote, but the kind of thing worth pinning.
  it('keeps a platform secret distinct from an org secret with the same names', () => {
    const platform: SecretIdentity = { organizationId: null, provider: 'p', secretName: 's' };
    const scoped: SecretIdentity = { organizationId: 'null', provider: 'p', secretName: 's' };
    const sealed = encryptSecret('v', platform, 'platform.v1', keys);
    expect(() => decryptSecret(sealed, scoped, keys)).toThrow(SecretCryptoError);
  });
});

describe('secret-crypto — tampering and wrong keys', () => {
  it('refuses a flipped ciphertext bit', () => {
    const sealed = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0x01;
    expect(() => decryptSecret({ ...sealed, ciphertext: tampered }, gladia, keys)).toThrow(
      SecretCryptoError
    );
  });

  it('refuses a flipped auth tag bit', () => {
    const sealed = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    const tag = Buffer.from(sealed.authTag);
    tag[0] ^= 0x01;
    expect(() => decryptSecret({ ...sealed, authTag: tag }, gladia, keys)).toThrow(
      SecretCryptoError
    );
  });

  it('refuses the wrong key', () => {
    const sealed = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    expect(() => decryptSecret({ ...sealed, keyId: 'platform.v2' }, gladia, keys)).toThrow(
      SecretCryptoError
    );
  });

  it('reports a key id it does not hold, and does not leak the ring', () => {
    const sealed = encryptSecret('v', gladia, 'platform.v1', keys);
    try {
      decryptSecret({ ...sealed, keyId: 'platform.v9' }, gladia, keys);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as SecretCryptoError;
      expect(err.code).toBe('UNKNOWN_KEY_ID');
      expect(err.message).toContain('platform.v9');
      // An error message is a log line. It names the id and nothing else.
      expect(err.message).not.toContain(KEY_A.toString('base64'));
      expect(err.message).not.toContain(KEY_B.toString('base64'));
    }
  });

  it('refuses an unsupported algorithm rather than guessing', () => {
    const sealed = encryptSecret('v', gladia, 'platform.v1', keys);
    expect(() =>
      decryptSecret(
        { ...sealed, algorithm: 'aes-128-cbc' as unknown as 'aes-256-gcm' },
        gladia,
        keys
      )
    ).toThrow(/unsupported algorithm/);
  });

  // The failure mode this refusal prevents: a stored empty string looks like a
  // configured credential and authenticates as nobody, surfacing much later as
  // a puzzling 401 from the vendor.
  it('refuses to encrypt an empty secret', () => {
    expect(() => encryptSecret('', gladia, 'platform.v1', keys)).toThrow(/empty secret/);
  });
});

describe('secret-crypto — rotation', () => {
  it('re-encrypts under a new key and still decrypts', () => {
    const v1 = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    const v2 = rotateSecret(v1, gladia, 'platform.v2', keys);

    expect(v2.keyId).toBe('platform.v2');
    expect(decryptSecret(v2, gladia, keys)).toBe('gladia-live-key');
    // A fresh nonce, because rotation is a fresh encryption. Reusing the old
    // IV under the new key would be a nonce shared across two keys, which is
    // harmless in itself but indistinguishable from the reuse that is not.
    expect(v2.iv.equals(v1.iv)).toBe(false);
  });

  it('leaves the old ciphertext readable under the old key', () => {
    const v1 = encryptSecret('gladia-live-key', gladia, 'platform.v1', keys);
    rotateSecret(v1, gladia, 'platform.v2', keys);
    // Rotation is not destruction. Until the row is written, the old one must
    // still work, or a failure mid-rotation loses the credential.
    expect(decryptSecret(v1, gladia, keys)).toBe('gladia-live-key');
  });

  it('cannot rotate to a key it does not hold', () => {
    const v1 = encryptSecret('v', gladia, 'platform.v1', keys);
    expect(() => rotateSecret(v1, gladia, 'platform.v9', keys)).toThrow(/no key for key_id/);
  });
});

describe('keyRingFromEnv', () => {
  const good = randomBytes(32).toString('base64');

  it('maps TUGPT_SECRET_KEY_PLATFORM_V1 to the key id platform.v1', () => {
    const ring = keyRingFromEnv({ TUGPT_SECRET_KEY_PLATFORM_V1: good } as NodeJS.ProcessEnv);
    expect([...ring.keys()]).toEqual(['platform.v1']);
    expect(ring.get('platform.v1')).toHaveLength(32);
  });

  it('ignores unrelated variables', () => {
    const ring = keyRingFromEnv({
      TUGPT_SECRET_KEY_ORG_V1: good,
      LANGDOCK_API_CODE: 'not-a-key',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);
    expect([...ring.keys()]).toEqual(['org.v1']);
  });

  // Rejected at startup rather than at first use. The alternative is a server
  // that boots cleanly and fails on the first customer credential it touches.
  it('rejects a key of the wrong length at load time', () => {
    expect(() =>
      keyRingFromEnv({
        TUGPT_SECRET_KEY_PLATFORM_V1: Buffer.alloc(16).toString('base64'),
      } as NodeJS.ProcessEnv)
    ).toThrow(/expected 32/);
  });

  it('skips an empty value rather than admitting a zero-length key', () => {
    const ring = keyRingFromEnv({ TUGPT_SECRET_KEY_PLATFORM_V1: '' } as NodeJS.ProcessEnv);
    expect(ring.size).toBe(0);
  });

  it('returns an empty ring when nothing is configured', () => {
    expect(keyRingFromEnv({} as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe('secretsEqual', () => {
  // Recorded deliberately: replacing this function's body with `a === b`
  // escapes every assertion below. It was mutation-tested and it survives.
  //
  // That is not a gap to be closed with a cleverer test. A timing assertion
  // would fail on a loaded CI runner and pass on a quiet one, which is worse
  // than no assertion — it teaches people to rerun the build. The function
  // exists so that callers reach for it instead of `===`, and the thing that
  // enforces the constant-time property is `timingSafeEqual` itself, not this
  // file. A reviewer replacing it with `===` should know they are trading a
  // real property for one no test here will notice.
  it('is true for equal secrets and false otherwise', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
  });

  it('is false for different lengths without throwing', () => {
    // timingSafeEqual throws on length mismatch; the length check must come
    // first or every comparison against a wrong-length input is a crash.
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
  });
});
