# ADR-017: Spanish Is the Source of Truth; Locale Belongs to the Organization

## Status
Accepted

## Context
TuGPT ships in Ecuador on 1 December. Every pilot organization is Spanish-speaking,
the AI drafts are Spanish, and the first thing a prospect sees in a demo is the
dashboard. Until 2026-08-30 that dashboard was entirely English: "Draft Inbox",
"Approve", "This draft has been modified by another reviewer."

Two facts made this the moment to fix it rather than a later one.

**The mechanism has to precede the UI, not follow it.** M1 builds the app shell,
navigation, the thread view and the unified inbox across September. Every screen
built before an i18n mechanism exists hardcodes English and gets retrofitted
afterwards at roughly the cost of building it twice. The Dec 1 re-cut says this
plainly: i18n is a prerequisite of the first UI PR, not an October content pass.

**Some of the English was not in a string literal.** Status badges rendered
`status.charAt(0).toUpperCase() + status.slice(1)` over the database enum, so
"Approved" appeared on screen without the word existing anywhere in the source.
A translation effort that only looked for quoted English would have missed it,
and no dictionary can reach it. That pattern had to go regardless of which
library was chosen, which is part of why no library was chosen.

The product also already had two locale-shaped things that disagreed with each
other: `apps/web/src/config/locales.ts` declared `supportedLocales: ['es','en']`
that nothing read, and `public.profiles.preferred_locale` had existed since July
as an unconstrained `TEXT` column with no reader, typed in TypeScript as the
closed union `'es' | 'en'` — a claim the database was not enforcing.

## Decision

1. **Spanish is the source of truth, structurally.** `apps/web/src/i18n/es.ts`
   is a flat object of literal keys. `en.ts` is annotated
   `Record<keyof typeof es, string>`, so a key only English has is an
   excess-property error and a key English lacks is a missing-property error.
   "Spanish-first" is a property the compiler checks, not a convention reviewers
   remember.

2. **No i18n library.** next-intl and i18next solve locale-segmented routing,
   lazy namespace loading, and plural-rule engines for languages with more than
   two forms. This product has two locales, no locale routing, and a Node server
   that loads both dictionaries in a few kilobytes. What a library would cost is
   a routing convention and a runtime that every future UI PR must be written
   against. The whole mechanism is `i18n/index.ts` plus `i18n/provider.tsx`.

3. **Locale is a property of the organization, not of the browser.**
   `public.organizations.locale` — `NOT NULL DEFAULT 'es'`, CHECK-constrained to
   the supported set — is the only resolution source. `Accept-Language` is not
   consulted. A bakery in Quito with two reviewers gets one dashboard language:
   browser detection would give the owner Spanish and the assistant beside them
   English, looking at the same draft and describing different buttons to each
   other on the phone.

4. **The locale travels on the tenant context.** `AuthService.resolveTenantContext`
   already resolves the active organization through a membership check;
   `TenantContext.locale` comes back in the same round trip and from the same
   row. A second query would be a second opportunity to disagree about which
   organization is active.

5. **The supported set is defined once, in `@tugpt/database`.**
   `ORGANIZATION_LOCALES` is the TypeScript half of a contract whose other half
   is the CHECK constraint in `20260830000001`. `config/locales.ts` derives from
   it rather than declaring its own list. Adding a locale means editing the
   constant, the constraint, and adding a dictionary — and the parity test fails
   until the third step is done.

6. **Failure to determine a locale resolves to Spanish, never to an error.**
   `getRequestLocale` runs in the root layout. If Supabase is unreachable or its
   environment is missing, it returns the default rather than throwing, because
   a language lookup must not be able to 500 the login page someone would use to
   investigate. It is not an authentication decision and nothing downstream
   trusts it.

7. **API error text is translated by code, in the browser.** Route handlers keep
   returning English `message` values alongside their stable `code`
   (`error-mapper.ts`). The browser translates the code and falls back to the
   server's sentence for a code it has no entry for, so a newly mapped SQLSTATE
   shows an English explanation rather than a raw `P3B0…` identifier — and
   `dictionaries.test.ts` fails on the next run so it does not stay English.
   The alternative, localizing server-side, would thread the organization's
   locale into every route handler so the server could render text only the
   browser displays.

8. **`profiles.preferred_locale` is constrained but still unread.** The same
   migration gives it the CHECK the TypeScript union always implied. It gains no
   reader: a per-user override is a separate decision, and until someone takes
   it, there is exactly one answer to "what language is this dashboard in".

9. **Registers, so translations do not drift.** UI chrome — buttons, links,
   headings — avoids the second person entirely (`Recargar`, not `Recargue` or
   `Recarga`). Where the reader must be addressed it is **usted**, matching the
   voice the pilot AI configuration already uses with customers.

## Consequences

- **Every route is now dynamically rendered.** `getRequestLocale` reads cookies,
  and a Request-time API in the root layout opts the whole app in. In practice
  this changes `/auth/*` only — everything else is behind the proxy's auth check
  and was already dynamic — and TuGPT is served by a Node container, not a CDN.
  The alternative was resolving locale in a dashboard-only layout, which cannot
  set `<html lang>` and would have left that attribute lying to screen readers.

- **Dates format with the locale, not yet with the organization's timezone.**
  `formatDateTime` uses `es-EC` / `en-US`, so a reviewer reads dates in the
  order they expect. The *timezone* is still the browser's. `organizations.timezone`
  and an `org_today()` helper are scheduled for 16 October, and every date
  computation — quota rollover, trial expiry, follow-ups — moves onto org-local
  time then.

- **Adding a UI string is now two edits, and the second is enforced.** Spanish
  first, because TypeScript will not accept it in the other order.

- **The Amendment 7 guard needed widening.** `queryByRole('button', {name: /send/i})`
  was written against an English UI; a Spanish "Enviar" would have passed it. It
  now matches `/send|enviar/i`. Any future language adds its own verb to that
  pattern — the guard is a product invariant, not a translation.

- **ADR-016 point 2 is amended.** The root layout now exports
  `generateMetadata()` rather than a static `metadata` object, because the
  description is a translated string. `apps/web/tests/app-config.test.ts` pins
  `generateMetadata().title` to `TuGPT`; the guarantee ADR-016 recorded is
  unchanged, only the export it names.
