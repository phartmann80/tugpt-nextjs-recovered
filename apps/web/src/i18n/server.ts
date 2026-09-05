/**
 * Which language this request renders in.
 *
 * The answer is the active organization's `locale` column, never the browser's
 * `Accept-Language`. A bakery in Quito wants one dashboard language for every
 * reviewer it employs; browser detection would give the owner Spanish and the
 * assistant beside them English, looking at the same draft. ADR-017.
 *
 * The resolution itself lives in `@/lib/tenant/server`, because the app shell
 * needs the same answer — the organization's name and the reviewer's email
 * come from the same row this reads the locale from. Both are wrapped in React
 * `cache()`, so a page render resolves the organization once.
 */

import { cache } from 'react';
import { getSessionContext } from '@/lib/tenant/server';
import { DEFAULT_LOCALE } from './index';
import type { Locale } from './types';

/**
 * Never throws and never returns null.
 *
 * This runs in the root layout, so an exception here would turn a language
 * lookup into a 500 on every route, including the login page someone would use
 * to investigate. Spanish is a complete, correct answer for every organization
 * that exists — and for a request with no organization at all.
 */
export const getRequestLocale = cache(async (): Promise<Locale> => {
  const session = await getSessionContext();
  return session?.tenant?.locale ?? DEFAULT_LOCALE;
});
