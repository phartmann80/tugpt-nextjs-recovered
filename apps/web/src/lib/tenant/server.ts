/**
 * Who is asking, and on behalf of which organization.
 *
 * One resolver, wrapped in React `cache()`, so a request that needs the
 * locale (root layout), the organization name (app shell) and the reviewer's
 * email (app shell) pays for one round trip rather than three. Before this
 * existed, `i18n/server.ts` did the same work inline for the locale alone;
 * the shell would have been the second copy, and two copies of "which
 * organization is active" is two answers that can disagree.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { AuthService, type TenantContext } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';

export interface SessionContext {
  readonly userId: string;
  /** May be empty: Supabase permits users with no email on some providers. */
  readonly email: string;
  /** Null when the user belongs to no organization. */
  readonly tenant: TenantContext | null;
}

/**
 * Is there any chance this request is authenticated?
 *
 * `@supabase/ssr` stores the session in cookies named `sb-<ref>-auth-token`,
 * chunked with a `.0` / `.1` suffix when it is large. No such cookie means no
 * session, and asking Supabase to confirm that costs a network round trip on
 * every anonymous page load — including the login page, which is the one page
 * a signed-out visitor is guaranteed to hit.
 *
 * A wrong guess here degrades: the caller sees "not signed in" and renders the
 * default. It is not an authentication check and nothing downstream trusts it
 * — the proxy has already decided whether this request may see the page.
 */
async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return store
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
}

/**
 * The active session, or null when there isn't one.
 *
 * Never throws. Callers are layouts, which have to render something: a
 * language lookup or a header greeting must not be able to 500 a page, and
 * "signed out" is a state every caller here already handles. The proxy is what
 * keeps unauthenticated people off protected routes; this is presentation.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  try {
    if (!(await hasSessionCookie())) return null;

    const supabase = await createAuthenticatedServerClient();

    // `auth.getUser()` directly rather than `AuthService.getCurrentUser()`:
    // the latter also reads the profiles row to assemble a display name, and
    // nothing here needs one yet.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const tenant = await new AuthService(supabase).resolveTenantContext(user.id);
    return { userId: user.id, email: user.email ?? '', tenant };
  } catch {
    // Supabase unreachable, or its environment missing.
    return null;
  }
});
