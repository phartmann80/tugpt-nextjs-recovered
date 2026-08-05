import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Meta webhook signature using HMAC-SHA256.
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