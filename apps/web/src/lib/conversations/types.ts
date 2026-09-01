/**
 * @file types.ts
 * @description The shape of the unified inbox. The Sep 25 milestone.
 *
 * WHAT AN INBOX ROW DELIBERATELY DOES NOT CARRY
 *
 * No message preview. It is the obvious thing to put on a row, and it would
 * make triage easier, and it is the single largest expansion of customer data
 * this product could make: a preview turns a list request into a request that
 * returns a line of every customer's words at once, cached by whatever sits in
 * front of it. Amendment 6 asks for the minimum the screen needs, and what the
 * screen needs to route a reviewer is who, when, what state, and whether
 * anything is waiting — none of which is message text.
 *
 * No raw `contact_phone`. `contact_display` is the masked form and the only
 * form, for the reason `contact-display.ts` gives at length: the last time
 * this product had a field named after the raw value, it carried the raw value
 * for weeks with nothing rendering it.
 */

/** One row of the inbox. */
export interface InboxConversation {
  id: string;
  /** Masked — see `lib/draft-api/contact-display.ts`. Null when unknown. */
  contact_display: string | null;
  status: 'open' | 'needs_human' | 'closed';
  /**
   * When this conversation was last active.
   *
   * `conversations.activity_at`, which is `COALESCE(last_message_at,
   * created_at)` — not `last_message_at`, which is nullable and, under a DESC
   * sort, would put a conversation with an unreadable webhook timestamp above
   * every recent one. See migration 20260901000001.
   */
  activity_at: string;
  /**
   * The draft awaiting review on this conversation, or null if there is none.
   *
   * The one thing that makes an inbox an inbox rather than a list: it is both
   * the reason a reviewer would open this row rather than another and the
   * place opening it takes them. Computed for the whole page in a single
   * query, not per row.
   *
   * One field rather than a boolean beside an id. Two representations of one
   * fact is how a screen ends up saying "awaiting review" next to a row that
   * does not open — the same class of defect as a masked field beside an
   * unmasked one.
   *
   * A conversation can have more than one draft awaiting review: `ai_drafts`
   * is unique per *source message*, so two unanswered inbound messages produce
   * two drafts. This is the most recent, chosen by an explicit sort rather
   * than by whatever order the rows arrive in.
   */
  awaiting_draft_id: string | null;
}

/** The statuses a reviewer can filter to, plus "all". */
export const INBOX_FILTERS = ['all', 'open', 'needs_human', 'closed'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export interface InboxPage {
  conversations: InboxConversation[];
  /**
   * The cursor for the next page, or null when this is the last one.
   *
   * Null is the *only* signal that the inbox has ended. There is deliberately
   * no total count: a count and the rows it counts are taken at different
   * moments in a list that reorders itself, so a "1–20 of 47" that disagrees
   * with what is on screen is a bug report waiting to be filed. "There is
   * more" is the question a Next button actually asks.
   */
  next_cursor: string | null;
}
