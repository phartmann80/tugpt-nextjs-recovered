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

  // N3: Normalizer covers messages arrays
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

  it('returns empty array for invalid payload', () => {
    expect(normalizeWhatsAppEnvelope(null)).toEqual([]);
    expect(normalizeWhatsAppEnvelope({})).toEqual([]);
    expect(normalizeWhatsAppEnvelope({ entry: [] })).toEqual([]);
  });

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
});