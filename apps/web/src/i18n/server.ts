/**
 * Which language this request renders in.
 *
 * The answer is the active organization's `locale` column, never the browser's
 * `Accept-Language`. A bakery in Quito wants one dashboard language for every
 * reviewer it employs; browser detection would give the owner Spanish and the
 * assistant beside them English, looking at the same draft. ADR-017.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { AuthService } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { DEFAULT_LOCALE } from './index';
import type { Locale } from './types';

/**
 * Is there any chance this request is authenticated?
 *
 * `@supabase/ssr` stores the session in cookies named `sb-<ref>-auth-token`,
 * chunked with a `.0` / `.1` suffix when it is large. No such cookie means no
 * session, and asking Supabase to confirm that costs a network round trip on
 * every anonymous page load — including the login page, which is the one page
 * a signed-out visitor is guaranteed to hit.
 *
 * If the cookie naming convention ever changes, this returns false for a
 * signed-in reviewer and they get Spanish: the product default, on a product
 * that is Spanish-first. A wrong guess here is a cosmetic degradation, which is
 * why a heuristic is acceptable here and would not be in an auth check. It is
 * not one — nothing downstream trusts this.
 */
async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return store
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
}

export const getRequestLocale = cache(async (): Promise<Locale> => {
  try {
    if (!(await hasSessionCookie())) return DEFAULT_LOCALE;

    const supabase = await createAuthenticatedServerClient();

    // `auth.getUser()` directly rather than `AuthService.getCurrentUser()`:
    // the latter also reads the profiles row to assemble a display name, and
    // nothing here needs one.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEFAULT_LOCALE;

    const tenant = await new AuthService(supabase).resolveTenantContext(user.id);
    return tenant?.locale ?? DEFAULT_LOCALE;
  } catch {
    // Reached when Supabase is unreachable or its env vars are missing. This
    // runs in the root layout, so throwing here would turn a language lookup
    // into a 500 on every route, including the login page someone would use to
    // investigate. Spanish is a complete, correct answer for every
    // organization that exists today.
    return DEFAULT_LOCALE;
  }
});
