import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * @file secret-crypto.ts
 * @description AES-256-GCM for credentials stored in `platform_secrets` and
 * `organization_secrets` (migration 20260903000003).
 *
 * The application encrypts and decrypts; the database holds ciphertext and no
 * key. The reasoning for that split is written out in the migration header —
 * briefly, a key stored beside the ciphertext is not encryption, and a key
 * passed as a SQL parameter ends up in `pg_stat_activity` and in slow-query
 * logs, which are not places anyone audits for key material.
 */

/** 96 bits. The size GCM is specified and hardware-accelerated for. */
const IV_BYTES = 12;
/** 128 bits — the full tag. Truncating it weakens forgery resistance. */
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm' as const;

/** Identifies which row a ciphertext belongs to. See {@link aad}. */
export interface SecretIdentity {
  /** `null` for a platform secret, which belongs to no organization. */
  readonly organizationId: string | null;
  readonly provider: string;
  readonly secretName: string;
}

/** Exactly the columns the two secret tables store. */
export interface EncryptedSecret {
  readonly algorithm: typeof ALGORITHM;
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

/** A key id mapped to its 32 bytes. Supplied by the caller from its environment. */
export type KeyRing = ReadonlyMap<string, Buffer>;

export class SecretCryptoError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNKNOWN_KEY_ID'
      | 'BAD_KEY_LENGTH'
      | 'EMPTY_PLAINTEXT'
      | 'DECRYPT_FAILED'
      | 'ALGORITHM_UNSUPPORTED'
      | 'IDENTITY_MISMATCH'
  ) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/**
 * Additional Authenticated Data: the identity of the row this ciphertext
 * belongs to.
 *
 * This is the part worth understanding, because it is not decoration. GCM
 * authenticates the AAD along with the ciphertext, so a blob decrypts *only*
 * against the identity it was encrypted for. Without it, a ciphertext copied
 * from one organization's row into another's — by a mistaken backfill, a
 * botched restore, or a compromised `service_role` — would decrypt cleanly and
 * hand the second organization the first one's credential. With it, the tag
 * check fails and the read errors.
 *
 * The unit separator (0x1f) rather than a printable delimiter: a provider or
 * secret name containing the delimiter could otherwise make two different
 * identities produce the same AAD, which is the ambiguity this is here to
 * prevent. 0x1f cannot appear in either — both are constrained to identifier
 * text — and if that ever stops being true the failure is a decrypt error,
 * not a silent collision.
 */
function aad(identity: SecretIdentity): Buffer {
  const parts = [
    identity.organizationId ?? '',
    identity.provider,
    identity.secretName,
  ];
  return Buffer.from(parts.join(''), 'utf8');
}

function keyFor(keys: KeyRing, keyId: string): Buffer {
  const key = keys.get(keyId);
  if (!key) {
    // The id, not the ring's contents. An error message is a log line.
    throw new SecretCryptoError(`no key for key_id "${keyId}"`, 'UNKNOWN_KEY_ID');
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `key "${keyId}" is ${key.length} bytes, expected ${KEY_BYTES}`,
      'BAD_KEY_LENGTH'
    );
  }
  return key;
}

/**
 * Encrypts a credential for storage.
 *
 * A fresh random IV every call. GCM nonce reuse under one key breaks both
 * confidentiality and authentication, so this function never accepts an IV
 * from its caller — the one parameter that would let a caller get it wrong is
 * simply not offered. The database carries a `UNIQUE (key_id, iv)` index as a
 * canary in case that ever changes.
 */
export function encryptSecret(
  plaintext: string,
  identity: SecretIdentity,
  keyId: string,
  keys: KeyRing
): EncryptedSecret {
  // An empty credential is never a credential. Storing one produces a row that
  // looks configured and authenticates as nobody, and the failure surfaces
  // later as a puzzling 401 from a vendor rather than here.
  if (plaintext === '') {
    throw new SecretCryptoError('refusing to encrypt an empty secret', 'EMPTY_PLAINTEXT');
  }

  const key = keyFor(keys, keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(identity));

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);

  return {
    algorithm: ALGORITHM,
    keyId,
    iv,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}

/**
 * Decrypts a stored credential.
 *
 * Throws rather than returning null on any failure — a wrong key, a tampered
 * ciphertext, or a row read against the wrong identity all land in
 * `DECRYPT_FAILED`. A nullable return would invite `?? ''`, and an empty
 * string is exactly the value that turns a decryption failure into a request
 * authenticated with no credential.
 */
export function decryptSecret(
  stored: EncryptedSecret,
  identity: SecretIdentity,
  keys: KeyRing
): string {
  if (stored.algorithm !== ALGORITHM) {
    throw new SecretCryptoError(
      `unsupported algorithm "${stored.algorithm}"`,
      'ALGORITHM_UNSUPPORTED'
    );
  }

  const key = keyFor(keys, stored.keyId);
  const decipher = createDecipheriv(ALGORITHM, key, stored.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(stored.authTag);

  try {
    return Buffer.concat([
      decipher.update(stored.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately not forwarding the underlying message. Node's is
    // "Unsupported state or unable to authenticate data", which says nothing
    // useful and gets pasted into tickets; and distinguishing "wrong key" from
    // "tampered" from "wrong identity" is exactly the oracle an attacker
    // wants.
    throw new SecretCryptoError('secret failed to decrypt', 'DECRYPT_FAILED');
  }
}

/**
 * Re-encrypts a secret under a different key, without the plaintext leaving
 * this function.
 *
 * Rotation is the reason `key_id` is a mandatory column: it is what makes
 * "which rows are still on the retired key" a query rather than a guess. This
 * is the other half of that — a single call, so a rotation script never holds
 * a decrypted credential in a variable it might log.
 */
export function rotateSecret(
  stored: EncryptedSecret,
  identity: SecretIdentity,
  newKeyId: string,
  keys: KeyRing
): EncryptedSecret {
  const plaintext = decryptSecret(stored, identity, keys);
  return encryptSecret(plaintext, identity, newKeyId, keys);
}

/**
 * Builds a key ring from environment variables named `TUGPT_SECRET_KEY_<ID>`,
 * whose values are base64-encoded 32-byte keys.
 *
 * Ids are lowercased and `_` becomes `.` so that `TUGPT_SECRET_KEY_PLATFORM_V1`
 * is the key id `platform.v1` — which matches the namespacing the migration
 * relies on to keep platform and organization nonces in separate spaces.
 *
 * A key of the wrong length is rejected here rather than at first use. The
 * alternative is a server that starts cleanly and fails on the first customer
 * credential it touches.
 */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const prefix = 'TUGPT_SECRET_KEY_';
  const ring = new Map<string, Buffer>();

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || !value) continue;

    const keyId = name.slice(prefix.length).toLowerCase().replace(/_/g, '.');
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretCryptoError(
        `${name} decodes to ${key.length} bytes, expected ${KEY_BYTES}`,
        'BAD_KEY_LENGTH'
      );
    }
    ring.set(keyId, key);
  }

  return ring;
}

/**
 * Constant-time equality for two secrets.
 *
 * Exported because the comparison a caller reaches for is `===`, and on a
 * credential that leaks its length and its matching prefix through timing.
 * Lengths are compared first and non-constant-time, which is unavoidable and
 * not the interesting leak.
 */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
