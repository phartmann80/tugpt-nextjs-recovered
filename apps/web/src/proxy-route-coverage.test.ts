/**
 * classifyRoute() in proxy.ts is an allowlist of protected prefixes with a
 * public fallback:
 *
 *   if (/auth ...)        -> 'auth'
 *   if (/dashboard | /settings | /crm | /organizations) -> 'protected'
 *   return 'public'
 *
 * That fails open. A page added at a path nobody remembered to add to the
 * protected list is served by the proxy with no authentication check at all,
 * and nothing about writing that page would reveal it — the failure is
 * silence.
 *
 * Nothing in the app is exposed by this today: every page lives under
 * /dashboard or /auth, and every API route authenticates itself. But "nothing
 * is exposed today" is a fact about the current file listing, not a property
 * the code enforces, and it was not written down anywhere.
 *
 * These tests turn the fallback into a decision. The route table below must
 * match the app directory exactly, so a new route fails the suite until
 * somebody classifies it on purpose and records why. The last test is the one
 * with teeth: it fails the moment a page outside /auth becomes reachable
 * without an authentication check.
 *
 * Deliberately not changed here: classifyRoute itself still fails open.
 * Inverting it to deny-by-default is the stronger fix, but it would make the
 * WhatsApp webhook and the health endpoint redirect to /auth/login unless the
 * public allowlist were exactly right, and that is a change to the SSR
 * authentication path that deserves to be made and verified on its own.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { classifyRoute, type RouteType } from './proxy';

type RouteKind = 'page' | 'api';

interface RouteExpectation {
  path: string;
  kind: RouteKind;
  type: RouteType;
  /** Why this classification is correct. Required, especially for 'public'. */
  why: string;
}

const ROUTES: RouteExpectation[] = [
  {
    path: '/',
    kind: 'page',
    type: 'public',
    why: 'Landing page. Renders no tenant data.',
  },
  {
    path: '/auth/login',
    kind: 'page',
    type: 'auth',
    why: 'Sign-in. Must be reachable while signed out.',
  },
  {
    path: '/auth/callback',
    kind: 'page',
    type: 'auth',
    why: 'OAuth/magic-link return leg. Runs before a session exists.',
  },
  {
    path: '/auth/logout',
    kind: 'page',
    type: 'auth',
    why: 'Clears the session; must not redirect to login on the way out.',
  },
  {
    path: '/dashboard/drafts',
    kind: 'page',
    type: 'protected',
    why: 'Reviewer inbox. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard/drafts/[draftId]',
    kind: 'page',
    type: 'protected',
    why: 'Draft detail. The proxy is the only gate on the page shell.',
  },

  // Every /api/v1 route below is 'public' to the proxy on purpose: the proxy
  // performs no authentication for them, and each handler authenticates for
  // itself via createAuthenticatedServerClient + AuthService, with RLS behind
  // it. Do not read 'public' here as "unauthenticated" — read it as "the proxy
  // is not the thing authenticating this".
  {
    path: '/api/v1/auth/session',
    kind: 'api',
    type: 'auth',
    why: 'Session probe. Answers "am I signed in", so it must run signed out.',
  },
  {
    path: '/api/v1/health',
    kind: 'api',
    type: 'public',
    why: 'Liveness probe. Returns no tenant data and is polled without credentials.',
  },
  {
    path: '/api/v1/webhooks/whatsapp',
    kind: 'api',
    type: 'public',
    why: 'Meta calls this unauthenticated; it is gated by HMAC signature and the hardcoded whatsapp_integration flag (ADR-010 amendment 2).',
  },
  {
    path: '/api/v1/organizations',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates: 401 without a user, 403 on an x-tenant-id the user does not belong to.',
  },
  {
    path: '/api/v1/drafts',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the rows.',
  },
  {
    path: '/api/v1/drafts/[draftId]',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the row.',
  },
  {
    path: '/api/v1/drafts/[draftId]/approve',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/edit',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/reject',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/events',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes review events to the draft owner org.',
  },
  {
    path: '/api/v1/drafts/[draftId]/revisions',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes revisions to the draft owner org.',
  },
];

/**
 * Walk the app router directory and return every routable path, derived the
 * way Next derives it: a directory containing page.tsx or route.ts is a route.
 * Route groups `(name)` contribute no segment; `_private` folders are not
 * routable.
 */
function discoverRoutes(appDir: string): Array<{ path: string; kind: RouteKind }> {
  const found: Array<{ path: string; kind: RouteKind }> = [];

  function walk(dir: string, segments: string[]): void {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (entry === 'page.tsx' || entry === 'route.ts') {
        const routePath = '/' + segments.join('/');
        found.push({
          path: segments.length === 0 ? '/' : routePath,
          kind: entry === 'route.ts' ? 'api' : 'page',
        });
      }
    }

    for (const entry of entries) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const isRouteGroup = entry.startsWith('(') && entry.endsWith(')');
      walk(full, isRouteGroup ? segments : [...segments, entry]);
    }
  }

  walk(appDir, []);
  return found;
}

const APP_DIR = path.join(process.cwd(), 'src', 'app');

describe('proxy route classification coverage', () => {
  it('finds the app router directory (guards against a cwd change breaking these tests silently)', () => {
    expect(existsSync(APP_DIR)).toBe(true);
    expect(discoverRoutes(APP_DIR).length).toBeGreaterThan(0);
  });

  it('lists every routable path in the app directory, and no path that does not exist', () => {
    const discovered = discoverRoutes(APP_DIR)
      .map((r) => r.path)
      .sort();
    const expected = ROUTES.map((r) => r.path).sort();

    // A failure here means a route was added or removed. Add it to ROUTES with
    // a deliberate classification and a reason — do not delete this assertion.
    expect(discovered).toEqual(expected);
  });

  it('classifies each route the way the table says', () => {
    for (const route of ROUTES) {
      expect(classifyRoute(route.path), `${route.path} — ${route.why}`).toBe(route.type);
    }
  });

  it('records a reason for every route the proxy does not authenticate', () => {
    for (const route of ROUTES.filter((r) => r.type === 'public')) {
      expect(route.why.length, `${route.path} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('leaves no page outside /auth reachable without an authentication check', () => {
    const unguarded = ROUTES.filter((r) => r.kind === 'page' && classifyRoute(r.path) === 'public').map(
      (r) => r.path
    );

    // The landing page is the only one, and it renders no tenant data. If this
    // list grows, a page is being served to anyone who asks for it.
    expect(unguarded).toEqual(['/']);
  });

  it('matches the app directory on kind as well as path', () => {
    const discovered = new Map(discoverRoutes(APP_DIR).map((r) => [r.path, r.kind]));
    for (const route of ROUTES) {
      expect(discovered.get(route.path), `${route.path} kind`).toBe(route.kind);
    }
  });
});
