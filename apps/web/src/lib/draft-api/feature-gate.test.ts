import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checkDraftFeatureGate } from './feature-gate';
import type { TypedSupabaseClient } from '@tugpt/database';

const mockRpc = vi.fn();

function createMockClient() {
  return {
    rpc: mockRpc,
  } as unknown as TypedSupabaseClient;
}

describe('Draft Feature Gate', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('F1: Global flag disabled returns 503', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const client = createMockClient();
    const result = await checkDraftFeatureGate(client, 'org-1');

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.message).toBe('Feature unavailable');
  });

  it('F2: All flags pass returns allowed', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const client = createMockClient();
    const result = await checkDraftFeatureGate(client, 'org-1');

    expect(result.allowed).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('F3: RPC error returns 503', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

    const client = createMockClient();
    const result = await checkDraftFeatureGate(client, 'org-1');

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.message).toBe('Feature unavailable');
  });

  it('F4: Null data returns 503', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    const client = createMockClient();
    const result = await checkDraftFeatureGate(client, 'org-1');

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
  });

  it('F5: Calls is_feature_enabled with correct args', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const client = createMockClient();
    await checkDraftFeatureGate(client, 'org-123');

    expect(mockRpc).toHaveBeenCalledWith('is_feature_enabled', {
      p_organization_id: 'org-123',
      p_flag_key: 'ai_draft_generation',
    });
  });
});