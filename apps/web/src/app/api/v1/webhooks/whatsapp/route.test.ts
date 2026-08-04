import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock feature flags
vi.mock('@tugpt/feature-flags', () => ({
  featureFlagService: {
    isEnabled: vi.fn().mockReturnValue(true),
  },
}));

// Mock database
vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn().mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null }),
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

describe('whatsapp webhook route', () => {
  beforeEach(() => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'test-verify-token');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
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

  // A3: GET webhook verification returns 403 when token mismatch
  it('GET returns 403 when token mismatch', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
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
    const rawBody = Buffer.from(malformedBody, 'utf-8');
    const mac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const signature = `sha256=${mac}`;
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      body: malformedBody,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
  });

  // A15: Unsupported content type returns 415
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

  // A4: POST webhook with valid signature calls ingest RPC and returns 200
  it('POST with valid signature and empty events returns 200', async () => {
    const body = { entry: [] };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
  });
});