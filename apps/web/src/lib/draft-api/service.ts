// Stage 5A: Draft API service layer
// Encapsulates Supabase queries for listing, detail, revisions, and events.
// Uses the user-session client (createServerClient) so RLS policies apply automatically.
// Amendment 2: Every read query also filters by the resolved active tenant's organization_id.

import type { TypedSupabaseClient } from '@tugpt/database';
import type {
  DraftListItem,
  DraftDetail,
  DraftSourceMessage,
  DraftConversationContext,
  ConversationThread,
  ThreadMessage,
  Revision,
  ReviewEvent,
} from './types';
import { maskContact } from './contact-display';

const DRAFTS_TABLE = 'ai_drafts';
const REVISIONS_TABLE = 'ai_draft_revisions';
const EVENTS_TABLE = 'ai_draft_review_events';
const MESSAGES_TABLE = 'messages';
const CONVERSATIONS_TABLE = 'conversations';

/**
 * How many messages a thread shows without being asked.
 *
 * Enough that a pilot conversation is shown whole, small enough that a long one
 * cannot turn a page render into a large response. `MAX_THREAD_LIMIT` exists
 * because the limit arrives from a query string: a caller asking for 100000 is
 * asking this server to read a conversation into memory, and "the client would
 * not do that" is not a bound.
 */
export const DEFAULT_THREAD_LIMIT = 50;
export const MAX_THREAD_LIMIT = 200;

export class DraftApiService {
  constructor(private supabase: TypedSupabaseClient) {}

  /**
   * List drafts for the active organization with optional status filter and pagination.
   * Amendment 2: Filters by organization_id from the resolved active tenant.
   */
  async listDrafts(
    organizationId: string,
    status: 'all' | 'draft' | 'approved' | 'rejected' = 'all',
    page: number = 1,
    limit: number = 20
  ): Promise<{ drafts: DraftListItem[]; total: number }> {
    const offset = (page - 1) * limit;
    const clampedLimit = Math.min(Math.max(limit, 1), 50);

    let query = this.supabase
      .from(DRAFTS_TABLE)
      .select(`
        id, status, version, provider, model,
        created_at, updated_at, reviewed_at, rejected_at,
        source_message_id
      `, { count: 'exact' })
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + clampedLimit - 1);

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      throw error;
    }

    const drafts = (data || []) as unknown as DraftListItem[];
    // Enrich with source message previews
    const enrichedDrafts: DraftListItem[] = [];

    for (const draft of drafts) {
      const sourcePreview = await this.getSourceMessagePreview(draft.source_message_id as unknown as string);
      const revisionPreview = await this.getCurrentRevisionPreview(
        draft.id,
        draft.version
      );

      enrichedDrafts.push({
        id: draft.id,
        status: draft.status,
        version: draft.version,
        provider: draft.provider,
        model: draft.model,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        reviewed_at: draft.reviewed_at,
        rejected_at: draft.rejected_at,
        source_message_preview: sourcePreview,
        current_revision_body_preview: revisionPreview,
      });
    }

    return { drafts: enrichedDrafts, total: count || 0 };
  }

  /**
   * Get a single draft with full detail including source message and conversation context.
   * Amendment 2: Filters by organization_id from the resolved active tenant.
   * Amendment 6: Minimizes customer data returned (no provider_message_id, no operational IDs).
   */
  async getDraftDetail(
    organizationId: string,
    draftId: string
  ): Promise<DraftDetail | null> {
    const { data: draft, error } = await this.supabase
      .from(DRAFTS_TABLE)
      .select(`
        id, status, version, provider, model,
        created_at, updated_at, reviewed_at, reviewed_by,
        rejected_at, rejected_by,
        source_message_id, conversation_id,
        current_revision_id
      `)
      .eq('id', draftId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !draft) {
      return null;
    }

    const draftData = draft as Record<string, unknown>;

    // Fetch current revision body
    const currentRevisionBody = await this.getCurrentRevisionBody(
      draftId,
      draftData['current_revision_id'] as string | null
    );

    // Fetch source message (amendment 6: minimal fields, no provider_message_id)
    const sourceMessage = await this.getSourceMessage(
      draftData['source_message_id'] as string,
      organizationId
    );

    // Fetch conversation context
    const conversation = await this.getConversation(
      draftData['conversation_id'] as string,
      organizationId
    );

    return {
      id: draftData['id'] as string,
      status: draftData['status'] as 'draft' | 'approved' | 'rejected',
      version: draftData['version'] as number,
      provider: draftData['provider'] as string | null,
      model: draftData['model'] as string | null,
      created_at: draftData['created_at'] as string,
      updated_at: draftData['updated_at'] as string,
      reviewed_at: draftData['reviewed_at'] as string | null,
      reviewed_by: draftData['reviewed_by'] as string | null,
      rejected_at: draftData['rejected_at'] as string | null,
      rejected_by: draftData['rejected_by'] as string | null,
      current_revision_body: currentRevisionBody,
      source_message: sourceMessage,
      conversation: conversation,
    };
  }

  /**
   * List all revisions for a draft.
   * Amendment 2: Filters by organization_id from the resolved active tenant.
   */
  async listRevisions(
    organizationId: string,
    draftId: string
  ): Promise<Revision[]> {
    const { data, error } = await this.supabase
      .from(REVISIONS_TABLE)
      .select('id, version, body, created_by_type, created_by_user_id, created_at')
      .eq('draft_id', draftId)
      .eq('organization_id', organizationId)
      .order('version', { ascending: false });

    if (error) {
      throw error;
    }

    return (data || []) as unknown as Revision[];
  }

  /**
   * List all review events for a draft.
   * Amendment 2: Filters by organization_id from the resolved active tenant.
   */
  async listReviewEvents(
    organizationId: string,
    draftId: string
  ): Promise<ReviewEvent[]> {
    const { data, error } = await this.supabase
      .from(EVENTS_TABLE)
      .select('id, action, actor_id, previous_version, new_version, created_at')
      .eq('draft_id', draftId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return (data || []) as unknown as ReviewEvent[];
  }

  /**
   * The conversation a draft belongs to, as a bounded window of messages.
   *
   * WHY IT IS SCOPED TO A DRAFT AND NOT TO A CONVERSATION
   *
   * The reviewer arrives here from a draft, and every existing authorization
   * and feature-gate path in this file is keyed on one — so this route reuses
   * them exactly rather than introducing a second way to be wrong. A
   * conversations API is a Sep 25 concern (the unified inbox), and what that
   * needs is a list of *conversations*, which is a different query, not this
   * one with a different door on it.
   *
   * WHY IT IS BOUNDED
   *
   * `messages.body` is up to 4096 characters and a conversation has no ceiling
   * on rows. Reading a whole conversation into a response because it happens to
   * be short today is the kind of thing that works for a year and then does not.
   * The window is the newest `limit` messages, returned oldest-first because
   * that is reading order.
   *
   * `has_more` comes from asking for one row more than the window and seeing
   * whether it arrives — no second COUNT query, and no possibility of the count
   * and the rows disagreeing because they were taken at different moments.
   *
   * Cursor pagination is deliberately not here. "Load older" belongs with the
   * inbox work that will also need it, and a cursor built now against one
   * screen's guess would be the second one written.
   */
  async getConversationThread(
    organizationId: string,
    draftId: string,
    limit = DEFAULT_THREAD_LIMIT
  ): Promise<ConversationThread | null> {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), MAX_THREAD_LIMIT);

    const { data: draftRow } = await this.supabase
      .from(DRAFTS_TABLE)
      .select('conversation_id, source_message_id')
      .eq('id', draftId)
      .eq('organization_id', organizationId)
      .single();

    if (!draftRow) return null;

    const draftData = draftRow as Record<string, unknown>;
    const conversationId = draftData['conversation_id'] as string;
    const sourceMessageId = draftData['source_message_id'] as string | null;

    const conversation = await this.getConversation(conversationId, organizationId);
    if (!conversation) return null;

    // `organization_id` as well as `conversation_id`. RLS already scopes this to
    // the caller's organizations, but RLS answers "may this user see the row",
    // not "is this row part of the conversation the caller asked about" — and
    // this is a request whose whole output is customer message text.
    const { data, error } = await this.supabase
      .from(MESSAGES_TABLE)
      .select('id, body, direction, created_at')
      .eq('conversation_id', conversationId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(bounded + 1);

    if (error) {
      throw error;
    }

    const rows = (data || []) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > bounded;
    const window = hasMore ? rows.slice(0, bounded) : rows;

    const messages: ThreadMessage[] = window
      .map((row) => ({
        id: row['id'] as string,
        body: (row['body'] as string | null) ?? null,
        direction: row['direction'] as 'inbound' | 'outbound',
        created_at: row['created_at'] as string,
        is_source: sourceMessageId !== null && row['id'] === sourceMessageId,
      }))
      .reverse();

    return {
      conversation_id: conversation.id,
      contact_display: conversation.contact_display,
      status: conversation.status,
      messages,
      has_more: hasMore,
      source_in_window: messages.some((m) => m.is_source),
    };
  }

  // --- Private helpers ---

  private async getSourceMessagePreview(
    sourceMessageId: string
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from(MESSAGES_TABLE)
      .select('body')
      .eq('id', sourceMessageId)
      .single();

    if (!data) return null;
    const body = (data as Record<string, unknown>)['body'] as string | null;
    if (!body) return null;
    return body.substring(0, 80);
  }

  private async getCurrentRevisionPreview(
    draftId: string,
    version: number
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from(REVISIONS_TABLE)
      .select('body')
      .eq('draft_id', draftId)
      .eq('version', version)
      .single();

    if (!data) return null;
    const body = (data as Record<string, unknown>)['body'] as string | null;
    if (!body) return null;
    return body.substring(0, 200);
  }

  private async getCurrentRevisionBody(
    draftId: string,
    revisionId: string | null
  ): Promise<string | null> {
    if (!revisionId) return null;

    const { data } = await this.supabase
      .from(REVISIONS_TABLE)
      .select('body')
      .eq('id', revisionId)
      .eq('draft_id', draftId)
      .single();

    if (!data) return null;
    return (data as Record<string, unknown>)['body'] as string | null;
  }

  /**
   * Get source message context (amendment 6: minimal fields).
   * Returns: body, direction, created_at, masked contact display.
   * Does NOT return provider_message_id.
   */
  private async getSourceMessage(
    messageId: string,
    organizationId: string
  ): Promise<DraftSourceMessage | null> {
    const { data } = await this.supabase
      .from(MESSAGES_TABLE)
      .select('body, direction, created_at')
      .eq('id', messageId)
      .eq('organization_id', organizationId)
      .single();

    if (!data) return null;

    const msgData = data as Record<string, unknown>;

    // Get contact display from conversation (masked)
    const { data: draftRow } = await this.supabase
      .from(DRAFTS_TABLE)
      .select('conversation_id')
      .eq('source_message_id', messageId)
      .eq('organization_id', organizationId)
      .single();

    let contactDisplay: string | null = null;
    if (draftRow) {
      const convId = (draftRow as Record<string, unknown>)['conversation_id'] as string;
      const { data: conv } = await this.supabase
        .from(CONVERSATIONS_TABLE)
        .select('contact_phone')
        .eq('id', convId)
        .eq('organization_id', organizationId)
        .single();

      if (conv) {
        contactDisplay = maskContact(
          (conv as Record<string, unknown>)['contact_phone'] as string
        );
      }
    }

    return {
      body: msgData['body'] as string | null,
      direction: msgData['direction'] as 'inbound' | 'outbound',
      created_at: msgData['created_at'] as string,
      contact_display: contactDisplay,
    };
  }

  private async getConversation(
    conversationId: string,
    organizationId: string
  ): Promise<DraftConversationContext | null> {
    const { data } = await this.supabase
      .from(CONVERSATIONS_TABLE)
      .select('id, contact_phone, status')
      .eq('id', conversationId)
      .eq('organization_id', organizationId)
      .single();

    if (!data) return null;

    const convData = data as Record<string, unknown>;
    return {
      id: convData['id'] as string,
      // Masked. This returned the raw number until 2026-09-01 — see
      // `contact-display.ts` for how long that had been true and why nothing
      // noticed.
      contact_display: maskContact(convData['contact_phone'] as string),
      status: convData['status'] as 'open' | 'needs_human' | 'closed',
    };
  }
}