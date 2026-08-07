import { describe, expect, it } from 'vitest';
import { mapDraftRpcError } from './error-mapper';

describe('Draft RPC Error Mapper', () => {
  it('E1: P3B01 maps to 404 with "Draft not found"', () => {
    const result = mapDraftRpcError({ code: 'P3B01' });
    expect(result.status).toBe(404);
    expect(result.code).toBe('DRAFT_NOT_FOUND');
    expect(result.message).toBe('Draft not found');
  });

  it('E2: P3B02 maps to 403 with permission message', () => {
    const result = mapDraftRpcError({ code: 'P3B02' });
    expect(result.status).toBe(403);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).toBe('You do not have permission to perform this action');
  });

  it('E3: P3B03 maps to 409 with stale version message', () => {
    const result = mapDraftRpcError({ code: 'P3B03' });
    expect(result.status).toBe(409);
    expect(result.code).toBe('STALE_VERSION');
    expect(result.message).toBe('This draft has been modified by another reviewer. Please reload and try again.');
  });

  it('E4: P3B04 maps to 422 with invalid state transition message', () => {
    const result = mapDraftRpcError({ code: 'P3B04' });
    expect(result.status).toBe(422);
    expect(result.code).toBe('INVALID_STATE_TRANSITION');
    expect(result.message).toBe('This draft cannot be modified in its current state');
  });

  it('E5: P3B05 maps to 422 with invalid body message', () => {
    const result = mapDraftRpcError({ code: 'P3B05' });
    expect(result.status).toBe(422);
    expect(result.code).toBe('INVALID_BODY');
    expect(result.message).toBe('The draft body must not be empty');
  });

  it('E6: Unknown SQLSTATE maps to 500 with generic message', () => {
    const result = mapDraftRpcError({ code: 'XXXXX' });
    expect(result.status).toBe(500);
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).toBe('An unexpected error occurred');
  });

  it('E7: Null error maps to 500 with generic message', () => {
    const result = mapDraftRpcError(null);
    expect(result.status).toBe(500);
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).toBe('An unexpected error occurred');
  });
});