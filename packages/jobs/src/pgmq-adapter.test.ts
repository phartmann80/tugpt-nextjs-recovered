import { describe, it, expect, vi } from 'vitest';
import { PgmqAdapter, QueueReadError } from './pgmq-adapter';

// Mock Supabase client
function createMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('pgmq-adapter', () => {
  it('readJobs returns empty array when no messages', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: [], error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toEqual([]);
  });

  it('readJobs returns parsed messages', async () => {
    const mockData = [
      {
        msg_id: '123',
        read_ct: 1,
        payload: { webhookEventId: 'abc', requestId: 'req1', timestamp: '2026-01-01T00:00:00Z' },
        enqueued_at: '2026-01-01T00:00:00Z',
        vt: '2026-01-01T00:00:30Z',
      },
    ];
    const adapter = new PgmqAdapter(createMockClient({ data: mockData, error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].msgId).toBe(123n);
    expect(jobs[0].readCt).toBe(1);
  });

  it('readJobs throws QueueReadError on RPC error', async () => {
    const adapter = new PgmqAdapter(
      createMockClient({ data: null, error: { message: 'RPC failed' } })
    );
    await expect(adapter.readJobs(1)).rejects.toThrow(QueueReadError);
  });

  it('deleteJob returns true on success', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: true, error: null }));
    const result = await adapter.deleteJob(123n);
    expect(result).toBe(true);
  });

  it('deleteJob returns false when RPC returns false', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: false, error: null }));
    const result = await adapter.deleteJob(123n);
    expect(result).toBe(false);
  });

  it('setVisibility returns true on success', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: true, error: null }));
    const result = await adapter.setVisibility(123n, 30);
    expect(result).toBe(true);
  });

  it('setVisibility returns false when RPC returns false', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: false, error: null }));
    const result = await adapter.setVisibility(123n, 30);
    expect(result).toBe(false);
  });
});