// Stage 5A: API response types for the draft review dashboard

export interface DraftListItem {
  id: string;
  status: 'draft' | 'approved' | 'rejected';
  version: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  rejected_at: string | null;
  source_message_preview: string | null;
  current_revision_body_preview: string | null;
  source_message_id?: string;
}

export interface DraftSourceMessage {
  body: string | null;
  direction: 'inbound' | 'outbound';
  created_at: string;
  contact_display: string | null;
}

export interface DraftConversationContext {
  id: string;
  contact_phone: string;
  status: 'open' | 'needs_human' | 'closed';
}

export interface DraftDetail {
  id: string;
  status: 'draft' | 'approved' | 'rejected';
  version: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  current_revision_body: string | null;
  source_message: DraftSourceMessage | null;
  conversation: DraftConversationContext | null;
}

export interface Revision {
  id: string;
  version: number;
  body: string;
  created_by_type: 'system' | 'user';
  created_by_user_id: string | null;
  created_at: string;
}

export interface ReviewEvent {
  id: string;
  action: 'approve' | 'edit' | 'reject';
  actor_id: string;
  previous_version: number;
  new_version: number;
  created_at: string;
}

export interface DraftListResponse {
  drafts: DraftListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DraftDetailResponse {
  draft: DraftDetail;
}

export interface RevisionListResponse {
  revisions: Revision[];
}

export interface ReviewEventListResponse {
  events: ReviewEvent[];
}

export interface DraftActionResponse {
  draft: {
    id: string;
    status: string;
    version: number;
    reviewed_at?: string | null;
    reviewed_by?: string | null;
    rejected_at?: string | null;
    rejected_by?: string | null;
    current_revision_id?: string | null;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}