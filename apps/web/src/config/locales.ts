/**
 * Product identity, and the locale facts derived from the database contract.
 *
 * `name` stays here: ADR-016 makes this file the single source of the product
 * name, and the guard in `apps/worker/tests/no-dead-domain.test.ts` depends on
 * it staying that way.
 *
 * The locale fields no longer hold literals. The supported set is a property of
 * `public.organizations.locale`'s CHECK constraint, so it is defined once in
 * `@tugpt/database` and read from there — the same reason `layout.tsx` reads
 * the name from here rather than repeating it. The description moved into the
 * dictionaries (`app.description`), because it is a sentence a person reads and
 * therefore has a translation.
 */

import { ORGANIZATION_LOCALES, DEFAULT_ORGANIZATION_LOCALE } from '@tugpt/database';
import type { OrganizationLocale } from '@tugpt/database';

/**
 * The non-default locale, for the health endpoint's `locales.secondary`.
 *
 * Derived rather than written down, but "secondary" is a two-locale idea and
 * will stop meaning anything the day a third is added. It survives here because
 * the health payload has reported it since Stage 5A and changing that shape is
 * not this PR's business.
 */
const SECONDARY_LOCALE: OrganizationLocale =
  ORGANIZATION_LOCALES.find((l) => l !== DEFAULT_ORGANIZATION_LOCALE) ??
  DEFAULT_ORGANIZATION_LOCALE;

export const APP_CONFIG = {
  name: "TuGPT",
  primaryLocale: DEFAULT_ORGANIZATION_LOCALE,
  secondaryLocale: SECONDARY_LOCALE,
  supportedLocales: ORGANIZATION_LOCALES,
};

export type SupportedLocale = OrganizationLocale;
