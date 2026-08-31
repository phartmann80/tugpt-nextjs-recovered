import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Meta webhook signature using HMAC-SHA256.
 *
 * A blank `appSecret` — unset, empty, or whitespace-only — always returns
 * false. It is the one input that would otherwise make this function *more*
 * permissive the less it is given: HMAC keyed on the empty string is a
 * signature any caller can compute, so an unconfigured server would have
 * accepted every forged request as authentic. "No secret" is not a weak key,
 * it is a published one, and the only safe answer to it is no.
 *
 * That refusal belongs here rather than only in the caller. This function is
 * exported from `@tugpt/security`; the next caller to appear will pass whatever
 * it read from the environment, and will not think about this case either.
 *
 * @param rawBody - The raw request body bytes
 * @param signatureHeader - The value of the X-Hub-Signature-256 header (format: "sha256=<hex>")
 * @param appSecret - The WhatsApp App Secret stored as a server-side env var
 * @returns true if the signature is valid, false otherwise
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader) {
    return false;
  }

  if (!appSecret || appSecret.trim() === '') {
    return false;
  }

  // Validate format: sha256=<64 lowercase hex chars>
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }

  const providedHex = signatureHeader.slice(prefix.length).toLowerCase();
  if (providedHex.length !== 64 || !/^[0-9a-f]{64}$/.test(providedHex)) {
    return false;
  }

  // Compute expected HMAC
  const expectedMac = createHmac('sha256', appSecret).update(rawBody).digest();

  // Convert provided hex to buffer for constant-time comparison
  const providedMac = Buffer.from(providedHex, 'hex');

  // Lengths must match
  if (expectedMac.length !== providedMac.length) {
    return false;
  }

  return timingSafeEqual(expectedMac, providedMac);
}

/**
 * Extracts the signature from the X-Hub-Signature-256 header.
 * Returns null if the header is missing.
 */
export function extractSignature(headers: Headers): string | null {
  return headers.get('x-hub-signature-256');
}