/**
 * The shapes that make Spanish the source of truth.
 *
 * This file exists separately from `index.ts` so `en.ts` can import
 * `Dictionary` without importing the module that imports `en.ts`. The
 * dependency is one-way: es.ts → types.ts → en.ts → index.ts.
 */

import type { es } from './es';
import type { OrganizationLocale } from '@tugpt/database';

/**
 * Every string the UI can render, as a union of literal keys.
 *
 * Derived from the Spanish dictionary, so `t('drafts.inbox.titel')` does not
 * compile and neither does a key that only English has.
 */
export type MessageKey = keyof typeof es;

export type Dictionary = Record<MessageKey, string>;

/**
 * The dashboard's locale is the organization's locale — there is no separate
 * UI-language concept, and this alias is here to say so rather than to leave
 * two names that could drift apart.
 */
export type Locale = OrganizationLocale;

export type TranslationParams = Record<string, string | number>;

export interface Translator {
  (key: MessageKey, params?: TranslationParams): string;

  /**
   * Translate a key that is only known at runtime, falling back to `fallback`
   * when this dictionary has no entry.
   *
   * The one real caller is API error codes: the server sends a stable `code`
   * plus an English `message`, and a code this dictionary has not caught up
   * with should show the server's sentence rather than a raw identifier. Status
   * values and event actions do NOT need this — they are closed unions in
   * TypeScript, so `t(`drafts.status.${draft.status}`)` type-checks and the
   * compiler proves every case has a string.
   */
  maybe(key: string, fallback: string, params?: TranslationParams): string;

  readonly locale: Locale;
}
