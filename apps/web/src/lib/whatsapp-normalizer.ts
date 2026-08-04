import { createHash } from 'node:crypto';

/**
 * Normalizes a Meta WhatsApp webhook envelope into individual message events.
 * Supports multiple entries and multiple message changes in a single envelope.
 */

export interface NormalizedWhatsAppEvent {
  providerConnectionIdentifier: string;
  providerMessageId: string;
  contactIdentifier: string;
  messageKind: string;
  bodyText: string | null;
  providerTimestamp: string | null;
}

/**
 * Extracts individual message events from a Meta webhook payload.
 * Handles the nested entry -> changes -> value -> messages structure.
 */
export function normalizeWhatsAppEnvelope(payload: unknown): NormalizedWhatsAppEvent[] {
  const events: NormalizedWhatsAppEvent[] = [];

  if (!payload || typeof payload !== 'object') {
    return events;
  }

  const envelope = payload as Record<string, unknown>;
  const entries = envelope.entry;
  if (!Array.isArray(entries)) {
    return events;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;

    // Extract provider connection identifier (phone_number_id)
    const changes = entryObj.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const changeObj = change as Record<string, unknown>;
      const value = changeObj.value;
      if (!value || typeof value !== 'object') continue;
      const valueObj = value as Record<string, unknown>;

      // Get the phone_number_id (provider connection identifier)
      const metadata = valueObj.metadata;
      const providerConnectionIdentifier =
        metadata && typeof metadata === 'object'
          ? String((metadata as Record<string, unknown>).phone_number_id || '')
          : '';

      if (!providerConnectionIdentifier) continue;

      // Process messages array
      const messages = valueObj.messages;
      if (!Array.isArray(messages)) continue;

      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const msgObj = message as Record<string, unknown>;

        const providerMessageId = String(msgObj.id || '');
        if (!providerMessageId) continue;

        const from = String(msgObj.from || '');
        if (!from) continue;

        // Determine message kind and body
        let messageKind = 'text';
        let bodyText: string | null = null;

        if (msgObj.text && typeof msgObj.text === 'object') {
          messageKind = 'text';
          bodyText = String((msgObj.text as Record<string, unknown>).body || '');
        } else if (msgObj.type) {
          messageKind = String(msgObj.type);
          // For non-text messages, body may be null
          bodyText = null;
        }

        const providerTimestamp = msgObj.timestamp ? String(msgObj.timestamp) : null;

        events.push({
          providerConnectionIdentifier,
          providerMessageId,
          contactIdentifier: from,
          messageKind,
          bodyText,
          providerTimestamp,
        });
      }
    }
  }

  return events;
}

/**
 * Computes a deterministic canonical hash for a normalized event.
 * Uses a versioned JSON array canonicalization.
 */
export function computeCanonicalHash(event: {
  provider: string;
  providerConnectionIdentifier: string;
  providerMessageId: string;
  contactIdentifier: string;
  messageKind: string;
  bodyText: string | null;
  providerTimestamp: string | null;
}): string {
  const crypto = { createHash };

  // Normalize timestamp to integer Unix seconds
  let normalizedTimestamp: number | null = null;
  if (event.providerTimestamp) {
    const ts = parseInt(event.providerTimestamp, 10);
    if (!isNaN(ts)) {
      normalizedTimestamp = ts;
    }
  }

  const canonical = JSON.stringify([
    'whatsapp-event-v1',
    event.provider,
    event.providerConnectionIdentifier,
    event.providerMessageId,
    event.contactIdentifier,
    event.messageKind,
    event.bodyText,
    normalizedTimestamp,
  ]);

  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf-8')).digest('hex');
}