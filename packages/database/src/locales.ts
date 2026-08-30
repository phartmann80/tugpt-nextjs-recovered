/**
 * The locales an organization can be set to.
 *
 * This list is the TypeScript half of a two-part contract. The other half is
 * the CHECK constraint on `public.organizations.locale`, added in
 * `20260830000001_add_organizations_locale.sql`. Adding a locale means editing
 * both, plus adding a dictionary in `apps/web/src/i18n` — and the dictionary
 * guard test fails until that third step is done, which is the point.
 *
 * It lives in `@tugpt/database` rather than in the web app because the set of
 * legal values is a property of the database, and because `@tugpt/auth` needs
 * it too: locale travels with the tenant context, not with the browser.
 */

export const ORGANIZATION_LOCALES = ['es', 'en'] as const;

export type OrganizationLocale = (typeof ORGANIZATION_LOCALES)[number];

/**
 * Spanish, and not as a placeholder for "whatever the browser asked for".
 *
 * TuGPT is sold in Ecuador; the product decision recorded in ADR-017 is that
 * Spanish is the source of truth and English is the translation. Every default
 * in the system points here.
 */
export const DEFAULT_ORGANIZATION_LOCALE: OrganizationLocale = 'es';

export function isOrganizationLocale(value: unknown): value is OrganizationLocale {
  return (
    typeof value === 'string' &&
    (ORGANIZATION_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Coerce an untrusted value to a locale we can actually render.
 *
 * Deliberately total: it never throws and never returns null. The caller is
 * always somewhere that has to render *something* — a layout, a tenant
 * context — and refusing to pick a language is not one of the options. A value
 * the constraint should have rejected degrades to Spanish, which is the same
 * thing an unconfigured organization gets.
 */
export function normalizeOrganizationLocale(value: unknown): OrganizationLocale {
  return isOrganizationLocale(value) ? value : DEFAULT_ORGANIZATION_LOCALE;
}
