'use client';

/**
 * Client-side access to the dictionary.
 *
 * Only the locale crosses the server/client boundary — two characters — because
 * both dictionaries are already in the client bundle (client components need
 * them) and serialising a hundred strings into the RSC payload on every page
 * would be paying twice for the same text.
 */

import { createContext, useContext, useMemo } from 'react';
import { createTranslator, DEFAULT_LOCALE } from './index';
import type { Locale, Translator } from './types';

/**
 * The default is a working Spanish translator, not null.
 *
 * A component rendered outside the provider — a unit test rendering
 * `DraftActions` on its own, an error boundary above the layout — gets Spanish
 * rather than a crash or a screen of raw keys. The cost is that a genuinely
 * missing provider is invisible in Spanish orgs; the benefit is that the
 * failure mode of the *language* mechanism is never a blank page in a product
 * whose reviewers are approving customer replies.
 */
const I18nContext = createContext<Translator>(createTranslator(DEFAULT_LOCALE));

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const translator = useMemo(() => createTranslator(locale), [locale]);
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useT(): Translator {
  return useContext(I18nContext);
}
