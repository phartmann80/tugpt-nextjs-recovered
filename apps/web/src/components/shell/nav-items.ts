import type { MessageKey } from '@/i18n/types';

export interface NavItem {
  /** Route this links to. Must be a real page route. */
  readonly href: string;
  /** Dictionary key for the label. Typed, so a missing translation will not compile. */
  readonly labelKey: MessageKey;
}

/**
 * The primary navigation, in the order a reviewer reads it.
 *
 * Exported as data rather than written inline in the nav component because
 * `tests/app-routes-reachable.test.ts` checks it against the app directory:
 * the Sep 11 milestone is "every page reachable without typing a URL", and a
 * page added without a way to get to it should fail a test rather than wait
 * for somebody to notice they cannot find it.
 *
 * One entry today. The thread view (Sep 18) and the unified inbox (Sep 25) add
 * theirs here, and the guard is what makes forgetting to impossible.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard/drafts', labelKey: 'nav.drafts' },
];

/**
 * Is `pathname` inside this nav item's section?
 *
 * A draft's detail page is still "Borradores" as far as the reviewer is
 * concerned, so the inbox link stays marked while they read one. Matching on
 * segment boundaries rather than `startsWith` for the same reason `proxy.ts`
 * does: `/dashboard/draftsomething` is not `/dashboard/drafts`.
 */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
