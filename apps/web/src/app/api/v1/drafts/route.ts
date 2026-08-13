// Stage 5A: GET /api/v1/drafts — List drafts for the active organization
// Amendment 2: Filters by resolved active tenant's organization_id (not just RLS).
// Amendment 4: Sanitized error responses with stable envelope.
// Amendment 5: Exact SQLSTATE-to-HTTP mapping for unknown errors.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { DraftApiService } from '@/lib/draft-api/service';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import type { ApiError } from '@/lib/draft-api/types';

const VALID_STATUSES = ['all', 'draft', 'approved', 'rejected'] as const;
function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    // Amendment 2: Resolve active tenant
    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) {
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    // Feature gate check (service-role client)
    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkDraftFeatureGate(adminClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    // Parse query params
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status') || 'all';
    const pageParam = url.searchParams.get('page') || '1';
    const limitParam = url.searchParams.get('limit') || '20';

    // Amendment 4: Validate query params
    if (!VALID_STATUSES.includes(statusParam as typeof VALID_STATUSES[number])) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid status filter');
    }

    const page = parseInt(pageParam, 10);
    const limit = parseInt(limitParam, 10);
    if (isNaN(page) || page < 1) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid page number');
    }
    if (isNaN(limit) || limit < 1) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid limit');
    }

    // Amendment 2: Filter by active tenant's organization_id
    const draftService = new DraftApiService(supabase);
    const { drafts, total } = await draftService.listDrafts(
      activeTenant.organizationId,
      statusParam as 'all' | 'draft' | 'approved' | 'rejected',
      page,
      limit
    );

    defaultLogger.info('Draft list retrieved', {
      requestId,
      organizationId: activeTenant.organizationId,
      count: drafts.length,
    });

    return NextResponse.json({ drafts, total, page, limit });
  } catch (err) {
    defaultLogger.error('Draft list failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}