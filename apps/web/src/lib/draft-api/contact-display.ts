/**
 * @file contact-display.ts
 * @description How a customer's phone number is shown to a reviewer.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * Until 2026-09-01 the masking lived inline inside `getSourceMessage`, and the
 * function two definitions below it — `getConversation` — returned
 * `contact_phone` raw. The same number, in the same response object, masked in
 * one field and not in the other. The route's own header says "Amendment 6:
 * Minimizes customer data returned"; nothing in it was wrong except that the
 * rule was implemented in one place instead of applied in every place.
 *
 * Nothing rendered the raw field. It was fetched, typed, serialised and sent to
 * the browser on every draft-detail request, and displayed nowhere — which is
 * the worst version of this, because there was no symptom to notice.
 *
 * One function, one rule, and a test that walks the response for anything that
 * looks like a full phone number. A masking helper that a caller can simply
 * forget to use is the shape the original defect had.
 */

/**
 * Everything but the last four characters, replaced.
 *
 * The reviewer needs enough to tell two customers apart in a list and to match
 * a number against their own records. Four trailing characters does that; the
 * rest is data the dashboard has no use for.
 *
 * A short identifier is masked **completely**. `contact_phone` is constrained
 * to 1–32 characters, so a four-character value is legal — and "show the last
 * four" of a four-character value shows all of it, which is the one input where
 * this function would silently do the opposite of its job.
 */
export function maskContact(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  if (trimmed === '') return null;

  const VISIBLE = 4;
  if (trimmed.length <= VISIBLE) {
    return '***-***-****';
  }

  return `***-***-${trimmed.slice(-VISIBLE)}`;
}
