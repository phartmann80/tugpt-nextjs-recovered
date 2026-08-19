/**
 * @file draft-fixtures.ts
 * @description Deterministic test data for draft worker tests.
 * All data is synthetic. No real credentials, phone numbers, or customer content.
 */

import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// --- Mock data ---

export const MOCK_JOB_ID = '550e8400-e29b-41d4-a716-446655440000';
export const MOCK_ORG_ID = '660e8400-e29b-41d4-a716-446655440000';
export const MOCK_CONVERSATION_ID = '770e8400-e29b-41d4-a716-446655440000';
export const MOCK_SOURCE_MESSAGE_ID = '880e8400-e29b-41d4-a716-446655440000';
export const MOCK_BUSINESS_PROFILE_ID = '990e8400-e29b-41d4-a716-446655440000';
export const MOCK_MSG_ID = 12345n;

export const MOCK_JOB_ROW = {
  organization_id: MOCK_ORG_ID,
  conversation_id: MOCK_CONVERSATION_ID,
  source_message_id: MOCK_SOURCE_MESSAGE_ID,
  business_profile_id: MOCK_BUSINESS_PROFILE_ID,
};

export const MOCK_SOURCE_TEXT = 'Hello, I have a question about your services.';
export const MOCK_DRAFT_CONFIG = {
  business_instructions: 'Be helpful and concise.',
  personality: 'Professional and friendly.',
  response_rules: 'Always greet the customer.',
  tone: 'Warm',
  max_draft_length: 1000,
};

export const MOCK_DRAFT_TEXT = 'Hello! Thank you for reaching out. How can I help you today?';
export const MOCK_PROVIDER = 'langdock';
export const MOCK_MODEL = 'auto';

export const MOCK_QUEUE_MESSAGE = {
  msgId: MOCK_MSG_ID,
  readCt: 1,
  payload: {
    draftGenerationJobId: MOCK_JOB_ID,
    requestId: 'draft-test-001',
    timestamp: '2026-08-06T18:00:00.000Z',
  },
  enqueuedAt: '2026-08-06T17:55:00.000Z',
  vt: '2026-08-06T18:00:30.000Z',
};

// --- Mock Supabase client factory ---

export interface MockRpcConfig {
  // Map of RPC name → return value or error
  [rpcName: string]: {
    data?: unknown;
    error?: { code: string; message: string } | null;
  };
}

export interface MockQueryConfig {
  // Map of table name → { filter: { column, value }, data }
  [tableName: string]: {
    filters: Record<string, string>;
    data: Record<string, unknown> | null;
    error?: { code: string; message: string } | null;
  };
}

export function createMockClient(
  rpcConfig: MockRpcConfig = {},
  queryConfig: MockQueryConfig = {}
): SupabaseClient {
  const client = {
    rpc: vi.fn().mockImplementation((name: string, _params: Record<string, unknown>) => {
      const config = rpcConfig[name];
      if (config) {
        return Promise.resolve({
          data: config.data ?? null,
          error: config.error ?? null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn().mockImplementation((table: string) => {
      const config = queryConfig[table];
      const queryBuilder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((_col: string, _val: string) => {
          // Check if this filter matches
          return queryBuilder;
        }),
        single: vi.fn().mockImplementation(() => {
          if (config) {
            return Promise.resolve({
              data: config.data,
              error: config.error ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      };
      return queryBuilder;
    }),
  };

  return client as unknown as SupabaseClient;
}

// --- Mock orchestrator ---

/**
 * Sanitized provider detail as it arrives from a real Langdock 400.
 * Mirrors the failure seen on 2026-08-19 (`model: "auto"` rejected).
 */
export const MOCK_PROVIDER_DETAIL =
  'invalid_request_error: Invalid model, available models are: gpt-5-mini, gpt-5, o3';

export function createMockOrchestrator(
  behavior:
    | 'success'
    | 'fail-transient'
    | 'fail-permanent'
    | 'fail-empty'
    | 'fail-oversized'
    | 'fail-invalid-model'
) {
  return {
    generateDraft: vi.fn().mockImplementation(async () => {
      switch (behavior) {
        case 'success':
          return {
            success: true as const,
            result: {
              text: MOCK_DRAFT_TEXT,
              provider: MOCK_PROVIDER,
              model: MOCK_MODEL,
              latencyMs: 150,
            },
          };
        case 'fail-transient':
          return {
            success: false as const,
            error: {
              provider: 'langdock',
              category: 'HTTP_5XX',
              httpStatus: 500,
            },
          };
        case 'fail-permanent':
          return {
            success: false as const,
            error: {
              provider: 'langdock',
              category: 'HTTP_401',
              httpStatus: 401,
            },
          };
        case 'fail-empty':
          return {
            success: false as const,
            error: {
              provider: 'langdock',
              category: 'EMPTY_OUTPUT',
            },
          };
        case 'fail-oversized':
          return {
            success: false as const,
            error: {
              provider: 'langdock',
              category: 'OUTPUT_TOO_LONG',
            },
          };
        case 'fail-invalid-model':
          // A 400 from the provider: terminal, and it carries the provider's
          // own explanation of what was wrong.
          return {
            success: false as const,
            error: {
              provider: 'langdock',
              category: 'HTTP_400',
              httpStatus: 400,
              providerDetail: MOCK_PROVIDER_DETAIL,
            },
          };
        default:
          return { success: false as const, error: { provider: 'langdock', category: 'UNKNOWN_FAILURE' } };
      }
    }),
  };
}