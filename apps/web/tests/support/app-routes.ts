/**
 * Reads the app router directory the way Next does, for the guards that check
 * the route table and the navigation against reality.
 *
 * Test support, not shipped: it touches `node:fs`, and nothing under `src/`
 * should be able to import that by accident.
 *
 * It lives here rather than inside one of the two test files because both
 * `src/proxy-route-coverage.test.ts` (is every route classified on purpose?)
 * and `tests/app-routes-reachable.test.ts` (can a person get to every page
 * without typing a URL?) ask the same question of the filesystem, and two
 * walkers would eventually disagree about what a route is.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type RouteKind = 'page' | 'api';

export interface DiscoveredRoute {
  readonly path: string;
  readonly kind: RouteKind;
}

/** `apps/web/src/app`, resolved from the package root vitest runs in. */
export const APP_DIR = path.join(process.cwd(), 'src', 'app');

/**
 * Every routable path under `appDir`.
 *
 * A directory containing `page.tsx` or `route.ts` is a route. Route groups
 * `(name)` contribute no segment; `_private` folders are not routable. A
 * `layout.tsx` is deliberately not a route — it has no URL of its own.
 */
export function discoverRoutes(appDir: string): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

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
