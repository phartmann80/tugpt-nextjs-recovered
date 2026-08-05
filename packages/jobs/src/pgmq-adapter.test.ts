import { describe, it, expect, vi } from 'vitest';
import { PgmqAdapter, QueueReadError, QueueDeleteError, QueueVisibilityError } from './pgmq-adapter';

// Mock Supabase client
function createMockClient(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('pgmq-adapter', () => {
  // Q1: readJobs returns empty array when no messages
  it('readJobs returns empty array when no messages', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: [], error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toEqual([]);
  });

  // Q2: readJobs returns parsed messages
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

  // Q3: readJobs throws QueueReadError on RPC error
  it('readJobs throws QueueReadError on RPC error', async () => {
    const adapter = new PgmqAdapter(
      createMockClient({ data: null, error: { message: 'RPC failed' } })
    );
    await expect(adapter.readJobs(1)).rejects.toThrow(QueueReadError);
  });

  // Q4: readJobs returns multiple messages
  it('readJobs returns multiple messages when available', async () => {
    const mockData = [
      { msg_id: '1', read_ct: 0, payload: {}, enqueued_at: '2026-01-01T00:00:00Z', vt: '2026-01-01T00:00:30Z' },
      { msg_id: '2', read_ct: 1, payload: {}, enqueued_at: '2026-01-01T00:00:01Z', vt: '2026-01-01T00:00:31Z' },
      { msg_id: '3', read_ct: 2, payload: {}, enqueued_at: '2026-01-01T00:00:02Z', vt: '2026-01-01T00:00:32Z' },
    ];
    const adapter = new PgmqAdapter(createMockClient({ data: mockData, error: null }));
    const jobs = await adapter.readJobs(3);
    expect(jobs).toHaveLength(3);
    expect(jobs[0].msgId).toBe(1n);
    expect(jobs[2].msgId).toBe(3n);
  });

  // Q5: readJobs returns delivery count (read_ct)
  it('readJobs returns delivery count in readCt field', async () => {
    const mockData = [
      { msg_id: '42', read_ct: 5, payload: {}, enqueued_at: '2026-01-01T00:00:00Z', vt: '2026-01-01T00:00:30Z' },
    ];
    const adapter = new PgmqAdapter(createMockClient({ data: mockData, error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs[0].readCt).toBe(5);
  });

  // Q6: readJobs handles null data as empty array
  it('readJobs returns empty array when data is null', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: null, error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs).toEqual([]);
  });

  // Q7: readJobs preserves payload object
  it('readJobs preserves payload object from queue', async () => {
    const payload = { webhookEventId: 'evt-123', requestId: 'req-456', timestamp: '2026-01-01T00:00:00Z' };
    const mockData = [
      { msg_id: '1', read_ct: 0, payload, enqueued_at: '2026-01-01T00:00:00Z', vt: '2026-01-01T00:00:30Z' },
    ];
    const adapter = new PgmqAdapter(createMockClient({ data: mockData, error: null }));
    const jobs = await adapter.readJobs(1);
    expect(jobs[0].payload).toEqual(payload);
  });

  // Q8: deleteJob returns true on success
  it('deleteJob returns true on success', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: true, error: null }));
    const result = await adapter.deleteJob(123n);
    expect(result).toBe(true);
  });

  // Q9: deleteJob returns false when RPC returns false
  it('deleteJob returns false when RPC returns false', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: false, error: null }));
    const result = await adapter.deleteJob(123n);
    expect(result).toBe(false);
  });

  // Q10: deleteJob throws QueueDeleteError on RPC error
  it('deleteJob throws QueueDeleteError on RPC error', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: null, error: { message: 'Delete failed' } }));
    await expect(adapter.deleteJob(123n)).rejects.toThrow(QueueDeleteError);
  });

  // Q11: setVisibility returns true on success
  it('setVisibility returns true on success', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: true, error: null }));
    const result = await adapter.setVisibility(123n, 30);
    expect(result).toBe(true);
  });

  // Q12: setVisibility returns false when RPC returns false
  it('setVisibility returns false when RPC returns false', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: false, error: null }));
    const result = await adapter.setVisibility(123n, 30);
    expect(result).toBe(false);
  });

  // Q13: setVisibility throws QueueVisibilityError on RPC error
  it('setVisibility throws QueueVisibilityError on RPC error', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: null, error: { message: 'Visibility failed' } }));
    await expect(adapter.setVisibility(123n, 30)).rejects.toThrow(QueueVisibilityError);
  });

  // Q14: Visibility-update failure is handled (returns false, not exception)
  it('setVisibility handles failure gracefully (returns false)', async () => {
    const adapter = new PgmqAdapter(createMockClient({ data: false, error: null }));
    const result = await adapter.setVisibility(999n, 60);
    expect(result).toBe(false);
  });

  // Q15: readJobs passes visibility timeout to RPC
  it('readJobs passes visibility timeout to RPC', async () => {
    const mockClient = createMockClient({ data: [], error: null });
    const adapter = new PgmqAdapter(mockClient);
    await adapter.readJobs(1, 45);
    expect(mockClient.rpc).toHaveBeenCalledWith('read_whatsapp_inbound_jobs', {
      p_visibility_timeout_seconds: 45,
      p_limit: 1,
    });
  });
});