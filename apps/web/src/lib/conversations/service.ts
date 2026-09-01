/**
 * @file service.ts
 * @description Reading the unified inbox. The Sep 25 milestone.
 */

import type { TypedSupabaseClient } from '@tugpt/database';
import { maskContact } from '@/lib/draft-api/contact-display';
import { encodeCursor, decodeCursor, type InboxCursor } from './cursor';
import type { InboxConversation, InboxFilter, InboxPage } from './types';

const CONVERSATIONS_TABLE = 'conversations';
const DRAFTS_TABLE = 'ai_drafts';

/**
 * How many conversations a page holds.
 *
 * `MAX_INBOX_LIMIT` exists because the limit arrives from a query string. A
 * caller asking for 100000 is asking this server to read an organization's
 * whole conversation history into one response, and "the client would not do
 * that" has never been a bound.
 */
export const DEFAULT_INBOX_LIMIT = 25;
export const MAX_INBOX_LIMIT = 100;

export interface ListConversationsOptions {
  status?: InboxFilter;
  limit?: number;
  cursor?: InboxCursor | null;
}

export class ConversationInboxService {
  constructor(private supabase: TypedSupabaseClient) {}

  /**
   * One page of the inbox, most recently active first.
   *
   * TWO QUERIES, NOT ONE PER ROW
   *
   * `awaiting_review` needs the drafts table, and the obvious way to get it is
   * to ask per conversation. `listDrafts` does the equivalent — two extra
   * queries per row — so a 20-row page there is 41 round trips, which is the
   * shape of that method and not something to copy. Here the whole page's
   * conversation ids go to the drafts table in one `.in()`, so a page costs two
   * queries whether it holds one conversation or a hundred.
   *
   * HOW "IS THERE MORE" IS ANSWERED
   *
   * By asking for one row more than the page and seeing whether it arrives —
   * the same technique as `getConversationThread`, for the same reason. A
   * separate COUNT is a second read of a list that reorders itself between the
   * two, so it can disagree with the rows it is counting.
   */
  async listConversations(
    organizationId: string,
    options: ListConversationsOptions = {}
  ): Promise<InboxPage> {
    const { status = 'all', limit = DEFAULT_INBOX_LIMIT, cursor = null } = options;
    const bounded = Math.min(Math.max(1, Math.floor(limit)), MAX_INBOX_LIMIT);

    let query = this.supabase
      .from(CONVERSATIONS_TABLE)
      .select('id, contact_phone, status, activity_at')
      .eq('organization_id', organizationId);

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    if (cursor) {
      // "Strictly after the last row of the previous page", in the order below:
      // an earlier activity_at, or the same one with a smaller id. Written as
      // an OR because PostgREST has no row-value comparison; it is the same
      // predicate as `(activity_at, id) < (:activityAt, :id)`.
      query = query.or(
        `activity_at.lt.${cursor.activityAt},` +
          `and(activity_at.eq.${cursor.activityAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query
      .order('activity_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(bounded + 1);

    if (error) {
      throw error;
    }

    const rows = (data || []) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > bounded;
    const window = hasMore ? rows.slice(0, bounded) : rows;

    const awaiting = await this.draftsAwaitingReview(
      organizationId,
      window.map((row) => row['id'] as string)
    );

    const conversations: InboxConversation[] = window.map((row) => ({
      id: row['id'] as string,
      contact_display: maskContact(row['contact_phone'] as string),
      status: row['status'] as InboxConversation['status'],
      activity_at: row['activity_at'] as string,
      awaiting_draft_id: awaiting.get(row['id'] as string) ?? null,
    }));

    const last = conversations[conversations.length - 1];
    return {
      conversations,
      // A cursor only when there is a page for it to lead to. Emitting one on
      // the last page gives the UI a Next button that fetches nothing.
      next_cursor:
        hasMore && last ? encodeCursor({ activityAt: last.activity_at, id: last.id }) : null,
    };
  }

  /**
   * The draft awaiting review on each of these conversations, if any.
   *
   * Scoped by organization as well as by id. The ids came from a query that was
   * already organization-scoped, so the filter is belt and braces — but it is
   * one `.eq()` on a request whose answer decides which drafts a reviewer is
   * offered, and the redundant filter costs nothing.
   *
   * WHY IT SORTS
   *
   * `ai_drafts` is unique per *source message*, not per conversation, so a
   * customer who sends two messages before anyone replies produces two drafts
   * in `draft` status on one conversation. Without an explicit sort, which one
   * the inbox links to is whatever order the rows came back in — stable enough
   * in testing to look deliberate, and free to change under a different plan.
   * Newest first, and the first one seen per conversation wins.
   */
  private async draftsAwaitingReview(
    organizationId: string,
    conversationIds: string[]
  ): Promise<Map<string, string>> {
    if (conversationIds.length === 0) return new Map();

    const { data, error } = await this.supabase
      .from(DRAFTS_TABLE)
      .select('id, conversation_id, created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .in('conversation_id', conversationIds);

    if (error) {
      throw error;
    }

    const rows = (data || []) as unknown as Array<Record<string, unknown>>;
    const newest = new Map<string, string>();
    for (const row of rows) {
      const conversationId = row['conversation_id'] as string;
      if (!newest.has(conversationId)) {
        newest.set(conversationId, row['id'] as string);
      }
    }
    return newest;
  }
}

export { decodeCursor, encodeCursor };
