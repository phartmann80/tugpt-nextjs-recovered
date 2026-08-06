// Stage 5A: POST /api/v1/drafts/:draftId/edit — Edit a draft body (creates new revision)
// Calls edit_draft(draftId, expectedLockVersion, body) RPC via user-session client.
// Amendment 1: Edit only allowed on draft status. Terminal drafts return P3B04 from DB.
// Amendment 2: Confirms draft is visible under active org before calling RPC.
// Amendment 5: Exact SQLSTATE-to-HTTP mapping.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createServerClient, createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> }
) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const { draftId } = await params;

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

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkDraftFeatureGate(adminClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    // Amendment 4: Parse and validate request body
    let body: { expectedLockVersion?: unknown; body?: unknown };
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    if (typeof body.expectedLockVersion !== 'number' || !Number.isInteger(body.expectedLockVersion)) {
      return errorResponse(400, 'INVALID_BODY', 'expectedLockVersion must be an integer');
    }

    if (typeof body.body !== 'string' || body.body.trim().length === 0) {
      return errorResponse(400, 'INVALID_BODY', 'Draft body must not be empty');
    }

    // Amendment 2: Confirm draft is visible under active org
    const { data: draftRow, error: visibilityError } = await supabase
      .from('ai_drafts')
      .select('id')
      .eq('id', draftId)
      .eq('organization_id', activeTenant.organizationId)
      .single();

    if (visibilityError || !draftRow) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    // Call the RPC using only draftId, expectedLockVersion, and body (no org argument)
    const { data, error: rpcError } = // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).rpc('edit_draft', {
      p_draft_id: draftId,
      p_expected_lock_version: body.expectedLockVersion,
      p_body: body.body,
    });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError);
      defaultLogger.warn('Draft edit RPC failed', {
        requestId,
        draftId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: rpcError.code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    defaultLogger.info('Draft edited', {
      requestId,
      draftId,
      organizationId: activeTenant.organizationId,
    });

    return NextResponse.json({ draft: data });
  } catch (err) {
    defaultLogger.error('Draft edit failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}