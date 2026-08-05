import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock feature flags
const mockIsEnabled = vi.fn().mockReturnValue(true);
vi.mock('@tugpt/feature-flags', () => ({
  featureFlagService: {
    isEnabled: mockIsEnabled,
  },
}));

// Mock database
const mockRpc = vi.fn().mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null });
vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

const APP_SECRET = 'test-secret';

// Helper to create a signed request
function createSignedRequest(body: object, secret: string = APP_SECRET): Request {
  const bodyStr = JSON.stringify(body);
  const rawBody = Buffer.from(bodyStr, 'utf-8');
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = `sha256=${mac}`;

  return new Request('http://localhost/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: bodyStr,
  });
}

function createSignedRawRequest(bodyStr: string, secret: string = APP_SECRET): Request {
  const rawBody = Buffer.from(bodyStr, 'utf-8');
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = `sha256=${mac}`;

  return new Request('http://localhost/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: bodyStr,
  });
}

describe('whatsapp webhook route', () => {
  beforeEach(() => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'test-verify-token');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockRpc.mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null });
  });

  // A1: GET webhook verification returns hub.challenge when token matches and flag enabled
  it('GET returns challenge when token matches', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abc123');
  });

  // A2: GET returns 403 when mode is not subscribe
  it('GET returns 403 when mode is not subscribe', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  // A3: GET webhook verification returns 403 when token mismatch
  it('GET returns 403 when token mismatch', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  // A4: POST webhook with valid signature calls ingest RPC and returns 200
  it('POST with valid signature and empty events returns 200', async () => {
    const body = { entry: [] };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
  });

  // A5: POST webhook with invalid signature returns 401
  it('POST with invalid signature returns 401', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(401);
  });

  // A6: POST webhook with missing signature returns 401
  it('POST with missing signature returns 401', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(401);
  });

  // A7: POST webhook with correctly signed malformed JSON returns 400
  it('POST with signed malformed JSON returns 400', async () => {
    const malformedBody = '{invalid json';
    const request = createSignedRawRequest(malformedBody);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
  });

  // A8: Feature disabled behavior — POST returns 404 when flag is off
  it('POST returns 404 when feature flag is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const body = { entry: [] };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(404);
  });

  // A9: Feature disabled behavior — GET returns 404 when flag is off
  it('GET returns 404 when feature flag is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(404);
  });

  // A10: Unsupported content type returns 415
  it('POST with unsupported content type returns 415', async () => {
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'test',
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(415);
  });

  // A11: Content-type with charset parameter is accepted
  it('POST with content-type charset parameter is accepted', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const rawBody = Buffer.from(bodyStr, 'utf-8');
    const mac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-hub-signature-256': `sha256=${mac}`,
      },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
  });

  // A12: POST with valid signature and real message events calls ingest RPC
  it('POST with valid message events calls ingest RPC', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test1', from: '15551234567', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('ingest_whatsapp_message_event', expect.objectContaining({
      p_provider_connection_identifier: '12345',
      p_provider_event_key: 'wamid.test1',
    }));
  });

  // A13: POST with ingest RPC error returns 500
  it('POST with ingest RPC error returns 500', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CONNECTION_NOT_FOUND' } });
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test2', from: '15551234567', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(500);
  });

  // A14: POST with multiple messages in one envelope ingests each independently
  it('POST with multiple messages ingests each independently', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'wamid.multi1', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' },
                  { id: 'wamid.multi2', from: '222', type: 'text', text: { body: 'B' }, timestamp: '1700000001' },
                ],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  // A15: POST with duplicate events (same message ID) calls ingest for each (dedup is DB-side)
  it('POST with duplicate message IDs calls ingest for each (dedup handled by DB)', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.dup', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.dup', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  // A16: Bounded raw-body reading — oversized body returns 413
  it('POST with oversized body returns 413', async () => {
    // Default limit is 1MB (1048576 bytes). Create a body larger than that.
    const largeString = 'x'.repeat(1100000);
    const largeBody = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'x' },
            messages: [{
              id: 'wamid.large',
              from: '1',
              type: 'text',
              text: { body: largeString },
              timestamp: '1',
            }],
          },
        }],
      }],
    });
    const request = createSignedRawRequest(largeBody);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(413);
  });
});