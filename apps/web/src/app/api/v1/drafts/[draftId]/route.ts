// Stage 5A: GET /api/v1/drafts/:draftId — Single draft detail with source message and conversation context
// Amendment 2: Filters by resolved active tenant's organization_id.
// Amendment 6: Minimizes customer data returned (no provider_message_id, no operational IDs).

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createServerClient, createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { DraftApiService } from '@/lib/draft-api/service';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> }
) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const { draftId } = await params;

    // Amendment 4: Validate UUID
    if (!UUID_REGEX.test(draftId)) {
      return errorResponse(400, 'INVALID_UUID', 'Invalid draft ID format');
    }

    const supabase = createServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) {
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    // Feature gate check
    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkDraftFeatureGate(adminClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    // Amendment 2: Filter by active tenant's organization_id
    const draftService = new DraftApiService(supabase);
    const draft = await draftService.getDraftDetail(activeTenant.organizationId, draftId);

    if (!draft) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    defaultLogger.info('Draft detail retrieved', {
      requestId,
      organizationId: activeTenant.organizationId,
      draftId,
    });

    return NextResponse.json({ draft });
  } catch (err) {
    defaultLogger.error('Draft detail failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}