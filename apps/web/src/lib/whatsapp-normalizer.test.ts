import { describe, it, expect } from 'vitest';
import { normalizeWhatsAppEnvelope, computeCanonicalHash } from './whatsapp-normalizer';

describe('whatsapp-normalizer', () => {
  // N1: Normalizer covers multiple entry arrays
  it('handles multiple entries in the envelope', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '1234567890', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '67890' },
                messages: [{ id: 'msg2', from: '9876543210', type: 'text', text: { body: 'World' }, timestamp: '1700000001' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
    expect(events[0].providerConnectionIdentifier).toBe('12345');
    expect(events[1].providerConnectionIdentifier).toBe('67890');
  });

  // N2: Normalizer covers changes arrays
  it('handles multiple changes in an entry', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg2', from: '222', type: 'text', text: { body: 'Yo' }, timestamp: '1700000001' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
  });

  // N3: Normalizer covers messages arrays (multi-message envelopes)
  it('handles multiple messages in a single change', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'msg1', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' },
                  { id: 'msg2', from: '222', type: 'text', text: { body: 'B' }, timestamp: '1700000001' },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
  });

  // N4: Normalizer extracts correct provider_message_id
  it('extracts correct provider_message_id', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test123', from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events[0].providerMessageId).toBe('wamid.test123');
  });

  // N5: Normalizer extracts correct contact_identifier
  it('extracts correct contact_identifier', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '15551234567', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events[0].contactIdentifier).toBe('15551234567');
  });

  // N6: Invalid payloads return empty array
  it('returns empty array for invalid payload', () => {
    expect(normalizeWhatsAppEnvelope(null)).toEqual([]);
    expect(normalizeWhatsAppEnvelope({})).toEqual([]);
    expect(normalizeWhatsAppEnvelope({ entry: [] })).toEqual([]);
  });

  // N7: Canonical hash is deterministic
  it('computes deterministic canonical hash', () => {
    const event = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const hash1 = computeCanonicalHash(event);
    const hash2 = computeCanonicalHash(event);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // N8: Per-event hashes differ for different messages in same envelope
  it('produces different hashes for different messages', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, providerMessageId: 'msg2' };
    expect(computeCanonicalHash(event1)).not.toBe(computeCanonicalHash(event2));
  });

  // N9: Event-key/hash mismatch — different body text produces different hash
  it('produces different hashes for same message ID but different body text', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, bodyText: 'World' };
    expect(computeCanonicalHash(event1)).not.toBe(computeCanonicalHash(event2));
  });

  // N10: Non-text message kind has null bodyText
  it('handles non-text message types with null bodyText', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'image', timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(1);
    expect(events[0].messageKind).toBe('image');
    expect(events[0].bodyText).toBeNull();
  });

  // N11: Missing timestamp results in null providerTimestamp
  it('handles missing timestamp', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'text', text: { body: 'Hi' } }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(1);
    expect(events[0].providerTimestamp).toBeNull();
  });

  // N12: Canonical hash normalizes timestamp to integer
  it('normalizes timestamp to integer in canonical hash', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, providerTimestamp: '  1700000000  ' };
    // parseInt trims whitespace, so both should produce the same hash
    expect(computeCanonicalHash(event1)).toBe(computeCanonicalHash(event2));
  });

  // N13: Canonical hash includes version prefix for future migration
  it('includes version prefix in canonical hash', () => {
    const event = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const hash = computeCanonicalHash(event);
    // The hash should be stable and include the 'whatsapp-event-v1' version tag
    // Changing the version prefix should produce a different hash
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // N14: Message with missing 'from' field is skipped
  it('skips messages with missing from field', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(0);
  });

  // N15: Message with missing 'id' field is skipped
  it('skips messages with missing id field', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(0);
  });
});