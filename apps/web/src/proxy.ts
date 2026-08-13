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

  // Handle protected routes authentication check using Supabase SSR
  if (routeType === 'protected') {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      // Fallback: no Supabase env configured, redirect to login
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Create a response that we can write refreshed cookies into
    const response = NextResponse.next({
      request: {
        headers: request.headers,
      },
    });

    const supabase = createSSRClient<Database>(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write refreshed cookies to both the request (so downstream
          // route handlers see them) and the response (so the browser
          // receives them).
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    // Use getClaims() for server-side auth verification.
    // getSession() does not revalidate the token and is not recommended
    // for server-side authorization checks per Supabase SSR guidance.
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

    if (claimsError || !claimsData) {
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Propagate headers to downstream route handlers and server components
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-request-id', requestId);
    if (activeTenantId) {
      requestHeaders.set('x-tenant-id', activeTenantId);
    }

    // Update the response with our request headers
    const finalResponse = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    // Copy any cookies that were set on the original response (from setAll)
    for (const cookie of response.cookies.getAll()) {
      finalResponse.cookies.set(cookie.name, cookie.value, cookie);
    }

    // Set response headers for client tracing
    finalResponse.headers.set('x-request-id', requestId);
    if (activeTenantId) {
      finalResponse.headers.set('x-tenant-id', activeTenantId);
    }

    return finalResponse;
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