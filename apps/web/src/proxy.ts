import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import type { Database } from '@tugpt/database';

export type RouteType = 'auth' | 'protected' | 'public';

export function classifyRoute(pathname: string): RouteType {
  if (pathname.startsWith('/auth') || pathname.startsWith('/api/v1/auth')) {
    return 'auth';
  }
  if (
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/crm') ||
    pathname.startsWith('/organizations')
  ) {
    return 'protected';
  }
  return 'public';
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Inject Request ID for distributed tracing
  const requestId =
    request.headers.get('x-request-id') ||
    `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const routeType = classifyRoute(pathname);

  // Propagate tenant context from cookie or x-tenant-id header if available
  const activeTenantId =
    request.cookies.get('tugpt_tenant_id')?.value ||
    request.headers.get('x-tenant-id') ||
    undefined;

  // Handle protected routes authentication check using Supabase SSR session
  if (routeType === 'protected') {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey) {
      const supabase = createSSRClient<Database>(supabaseUrl, supabaseKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            // Cannot set cookies in middleware/proxy; the browser client handles refresh.
          },
        },
      });

      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        const loginUrl = new URL('/auth/login', request.url);
        loginUrl.searchParams.set('redirect', pathname);
        return NextResponse.redirect(loginUrl);
      }
    } else {
      // Fallback: no Supabase env configured, redirect to login
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Propagate headers to downstream route handlers and server components
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  if (activeTenantId) {
    requestHeaders.set('x-tenant-id', activeTenantId);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Set response headers for client tracing
  response.headers.set('x-request-id', requestId);
  if (activeTenantId) {
    response.headers.set('x-tenant-id', activeTenantId);
  }

  return response;
}

export default proxy;

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};