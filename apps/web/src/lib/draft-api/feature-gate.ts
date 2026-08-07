// Stage 5A: Feature gate for draft review APIs
// Checks global + org-level feature flags via is_feature_enabled RPC (service-role client).
// Plan entitlement is deferred: no authoritative entitlement source exists yet.
// The entitlement check is behind a server-only interface using deterministic mocks in tests.

import type { TypedSupabaseClient } from '@tugpt/database';

export interface FeatureGateResult {
  allowed: boolean;
  statusCode: number;
  message: string;
}

const FLAG_KEY = 'ai_draft_generation';

/**
 * Check whether the AI draft generation feature is enabled for the given organization.
 * Uses a service-role Supabase client to call the is_feature_enabled RPC.
 *
 * Amendment 3: Plan entitlement is NOT invented here. The entitlement source is
 * documented as pending integration. The check is behind this server-only interface.
 * Tests use deterministic mocks.
 */
export async function checkDraftFeatureGate(
  adminClient: TypedSupabaseClient,
  organizationId: string
): Promise<FeatureGateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (adminClient as any).rpc('is_feature_enabled', {
    p_organization_id: organizationId,
    p_flag_key: FLAG_KEY,
  });

  if (error) {
    return {
      allowed: false,
      statusCode: 503,
      message: 'Feature unavailable',
    };
  }

  if (!data) {
    return {
      allowed: false,
      statusCode: 503,
      message: 'Feature unavailable',
    };
  }

  return {
    allowed: true,
    statusCode: 200,
    message: '',
  };
}