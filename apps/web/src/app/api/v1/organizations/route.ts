import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthenticated' },
        { status: 401 }
      );
    }

    // Server-side validation of active tenant
    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (rawTenantId && (!activeTenant || activeTenant.organizationId !== rawTenantId)) {
      return NextResponse.json(
        { error: 'Access denied to requested tenant' },
        { status: 403 }
      );
    }

    const orgs = await authService.getUserOrganizations(user.id);

    defaultLogger.info('Organizations list retrieved', {
      requestId,
      userId: user.id,
      count: orgs.length,
    });

    return NextResponse.json({
      organizations: orgs,
      activeTenant,
      total: orgs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    defaultLogger.error('Organizations list failed', err as Error, { requestId });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthenticated' },
        { status: 401 }
      );
    }

    const body = (await request.json()) as { name?: string; slug?: string };

    if (!body.name || !body.slug) {
      return NextResponse.json(
        { error: 'Missing required fields: name and slug' },
        { status: 400 }
      );
    }

    // Call public.create_organization_with_owner RPC
    // Args cast to unknown until supabase gen types is run to generate Database types.
    const { data: orgId, error: rpcError } = await supabase.rpc(
      'create_organization_with_owner',
      {
        p_name: body.name,
        p_slug: body.slug,
        p_owner_id: user.id,
      } as unknown as undefined
    );

    if (rpcError) {
      defaultLogger.error('Failed atomic organization creation RPC', rpcError, { requestId });
      return NextResponse.json({ error: 'Failed to create organization' }, { status: 400 });
    }

    defaultLogger.info('Organization created successfully', {
      requestId,
      organizationId: orgId,
      userId: user.id,
    });

    return NextResponse.json({
      success: true,
      organization: {
        id: orgId,
        name: body.name,
        slug: body.slug,
      },
    });
  } catch (err) {
    defaultLogger.error('Organization creation failed', err as Error, { requestId });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}