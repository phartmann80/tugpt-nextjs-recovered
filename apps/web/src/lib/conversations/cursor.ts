/**
 * @file cursor.ts
 * @description Keyset cursors for the unified inbox.
 *
 * WHY THE INBOX IS NOT PAGED THE WAY THE DRAFT LIST IS
 *
 * `listDrafts` uses `?page=` and OFFSET. That is defensible for a list ordered
 * by `created_at`, because a draft's creation time never changes: rows are
 * appended at the top and the ones below keep their positions.
 *
 * An inbox is ordered by *last activity*, and last activity changes. A
 * customer replying while a reviewer is on page 2 moves that conversation to
 * the top of page 1, which shifts every row after it down by one — and the row
 * that was pushed across the page boundary is the one the reviewer never sees.
 * They do not see a gap; they see a shorter list. With OFFSET, a busy inbox
 * silently hides conversations in proportion to how busy it is, which is
 * exactly backwards.
 *
 * A keyset cursor names the last row of the page instead of counting how many
 * rows came before it, so a page boundary means the same thing regardless of
 * what moved. #61 deferred this ("belongs with the inbox work that will also
 * need it"); this is that work.
 *
 * WHY THE CURSOR CARRIES AN ID AS WELL AS A TIME
 *
 * Two conversations can share an `activity_at` — one webhook batch carries one
 * `provider_timestamp`. `activity_at` alone is not a total order, so a page
 * boundary landing inside a tie can repeat a conversation on two consecutive
 * pages or skip one entirely. The id breaks the tie and makes the order total.
 *
 * WHY IT IS OPAQUE
 *
 * Base64 of the two fields, and not because they are secret — they are already
 * on screen. It is opaque so that its shape is not a promise. A caller that
 * reads `?cursor=` as "a timestamp I can edit" is a caller that pins the
 * contract to today's ordering key, and the next change to the ordering makes
 * their edited value mean something wrong rather than fail.
 */

export interface InboxCursor {
  /** ISO 8601, from `conversations.activity_at` of the last row on the page. */
  activityAt: string;
  /** That row's id, breaking `activity_at` ties. */
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO 8601 as `toISOString` emits it, and nothing else.
 *
 * The obvious check here is `Date.parse(value)` is not NaN, and it is not
 * enough. `Date.parse` accepts `"Sep 1, 2026"` and `"Mon, 01 Sep 2026 ..."`,
 * both of which contain a comma — and this value is interpolated into a
 * PostgREST `.or()` clause, where a comma separates filters. A permissive date
 * check would pass a string that changes what the query asks for.
 *
 * So the shape is pinned first and the date checked second. Nothing but a
 * cursor this server issued can satisfy both, and every character that could
 * mean something to the query builder is outside the pattern.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify([cursor.activityAt, cursor.id]), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or `null` if it is not one this server issued.
 *
 * Everything about the input is checked, because the input is a query string a
 * browser or a stale bookmark supplies. The two fields go into a database
 * filter, so "looks roughly right" is not the bar: the timestamp has to parse
 * as a date and the id has to be a UUID, or this returns null and the caller
 * refuses the request.
 *
 * Returning null rather than throwing keeps the decision at the call site,
 * which is where the difference between "ignore it" and "400" belongs — see
 * the route for why a bad cursor is a 400 while a bad `limit` is not.
 */
export function decodeCursor(raw: string | null | undefined): InboxCursor | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) return null;

  const [activityAt, id] = parsed;
  if (typeof activityAt !== 'string' || typeof id !== 'string') return null;
  if (!UUID.test(id)) return null;
  if (!ISO_INSTANT.test(activityAt)) return null;
  if (Number.isNaN(Date.parse(activityAt))) return null;

  return { activityAt, id };
}
