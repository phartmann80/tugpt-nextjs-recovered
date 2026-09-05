import type { ApiError } from './types';
import type { Translator } from '@/i18n/types';

/**
 * The sentence to show a reviewer when an API call fails.
 *
 * The API stayed English on purpose. It answers with a stable `code` plus a
 * sanitized English `message` (see `error-mapper.ts`), and localizing it would
 * mean threading the organization's locale into every route handler so the
 * server could render text only the browser displays. So the code is the
 * contract and the browser does the translating.
 *
 * The server's own sentence is the fallback, which matters the day a new
 * SQLSTATE is mapped: a reviewer sees an English explanation rather than a raw
 * `P3B0…` identifier, and `dictionaries.test.ts` fails on the next run so it
 * does not stay that way.
 */
export function apiErrorText(t: Translator, data: ApiError | undefined): string {
  const code = data?.error?.code;
  const serverMessage = data?.error?.message;
  const generic = t('errors.INTERNAL_ERROR');

  if (code) return t.maybe(`errors.${code}`, serverMessage || generic);
  return serverMessage || generic;
}
