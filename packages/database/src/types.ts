import type { OrganizationLocale } from './locales';

export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  /**
   * Reserved for a future per-user override. Nothing reads it — the dashboard
   * resolves language from `Organization.locale` (ADR-017). Constrained in the
   * database as of 20260830000001, so this union is now enforced rather than
   * merely asserted.
   */
  preferred_locale: OrganizationLocale;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  /** Language the dashboard renders in for this organization. See ADR-017. */
  locale: OrganizationLocale;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  /** Always stored lowercased and trimmed by `create_invitation`. */
  email: string;
  role: OrganizationRole;
  /**
   * SHA-256 of the token, hex. Never the token itself, and never presentable:
   * `accept_invitation` hashes what it is given, so sending this value back
   * does not accept the invitation (20260902000001).
   */
  token_hash: string;
  status: InvitationStatus;
  invited_by: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface FeatureFlag {
  id: string;
  organization_id: string | null;
  key: string;
  is_enabled: boolean;
  rules: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Phase 3B types

export interface AiDraftConfig {
  id: string;
  organization_id: string;
  business_profile_id: string;
  business_instructions: string;
  personality: string;
  response_rules: string;
  tone: string;
  max_draft_length: number;
  created_at: string;
  updated_at: string;
}

export interface AiDraft {
  id: string;
  organization_id: string;
  business_profile_id: string;
  conversation_id: string;
  source_message_id: string;
  current_revision_id: string | null;
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
}

export interface AiDraftRevision {
  id: string;
  organization_id: string;
  draft_id: string;
  version: number;
  body: string;
  created_by_type: 'system' | 'user';
  created_by_user_id: string | null;
  created_at: string;
}

export interface AiDraftReviewEvent {
  id: string;
  organization_id: string;
  draft_id: string;
  action: 'approve' | 'edit' | 'reject';
  actor_id: string;
  previous_version: number;
  new_version: number;
  created_at: string;
}

export interface DraftGenerationJob {
  id: string;
  organization_id: string;
  business_profile_id: string;
  conversation_id: string;
  source_message_id: string;
  draft_id: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'archived';
  provider: string | null;
  model: string | null;
  attempt_count: number;
  error_code: string | null;
  pgmq_msg_id: string;
  created_at: string;
  updated_at: string;
}

export interface DraftQuotaLimit {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  hard_ceiling: number;
  created_at: string;
  updated_at: string;
}

export interface DraftUsageTracking {
  id: string;
  organization_id: string;
  quota_limit_id: string;
  period_start: string;
  period_end: string;
  draft_count: number;
  reserved_count: number;
  created_at: string;
  updated_at: string;
}

export interface DraftUsageReservation {
  id: string;
  organization_id: string;
  draft_generation_job_id: string;
  quota_limit_id: string | null;
  status: 'reserved' | 'consumed' | 'released';
  created_at: string;
  updated_at: string;
}

// Phase 3A types

export interface BusinessProfile {
  id: string;
  organization_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnection {
  id: string;
  organization_id: string;
  business_profile_id: string;
  display_name: string | null;
  phone_number: string;
  provider_phone_number_id: string;
  status: 'pending' | 'active' | 'disconnected' | 'error';
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  provider: string;
  provider_event_key: string;
  event_kind: string;
  payload_sha256: string;
  status: 'received' | 'processed' | 'failed';
  received_at: string;
  processed_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
}

export interface InboundMessageStaging {
  id: string;
  webhook_event_id: string;
  provider_message_id: string;
  contact_identifier: string;
  message_kind: string;
  body_text: string | null;
  provider_timestamp: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  contact_phone: string;
  status: 'open' | 'needs_human' | 'closed';
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * `COALESCE(last_message_at, created_at)`, generated and STORED. Read-only —
   * the database rejects any attempt to write it (migration 20260901000001).
   *
   * Order inbox-style lists on this, never on `last_message_at`: that column is
   * nullable, DESC implies NULLS FIRST, and its only producer copies a nullable
   * unvalidated `provider_timestamp` into it — so a conversation whose webhook
   * carried no readable timestamp sorts above every recent one.
   */
  activity_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  organization_id: string;
  webhook_event_id: string;
  direction: 'inbound' | 'outbound';
  provider_message_id: string | null;
  body: string | null;
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
}

export interface FailedJob {
  id: string;
  webhook_event_id: string | null;
  job_type: string;
  request_id: string | null;
  error_code: string;
  attempts: number;
  queue_name: string;
  pgmq_msg_id: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string };
        Update: Partial<Profile>;
      };
      organizations: {
        Row: Organization;
        // `locale` is optional on insert because the column carries a default
        // ('es'). Requiring it here would force every caller to name a language
        // it does not care about, and the one value they would all pass is the
        // one the database already supplies.
        Insert: Omit<Organization, 'id' | 'created_at' | 'updated_at' | 'locale'> & { id?: string; created_at?: string; updated_at?: string; locale?: OrganizationLocale };
        Update: Partial<Organization>;
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Omit<OrganizationMember, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationMember>;
      };
      organization_invitations: {
        Row: OrganizationInvitation;
        // Read-only from the application as of 20260902000001: `authenticated`
        // holds SELECT and nothing else, and every write goes through
        // create_invitation / revoke_invitation / accept_invitation.
        Insert: never;
        Update: never;
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AuditLog>;
      };
      feature_flags: {
        Row: FeatureFlag;
        Insert: Omit<FeatureFlag, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<FeatureFlag>;
      };
      business_profiles: {
        Row: BusinessProfile;
        Insert: Omit<BusinessProfile, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<BusinessProfile>;
      };
      whatsapp_connections: {
        Row: WhatsAppConnection;
        Insert: Omit<WhatsAppConnection, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<WhatsAppConnection>;
      };
      webhook_events: {
        Row: WebhookEvent;
        Insert: Omit<WebhookEvent, 'id' | 'received_at'> & { id?: string; received_at?: string };
        Update: Partial<WebhookEvent>;
      };
      inbound_message_staging: {
        Row: InboundMessageStaging;
        Insert: Omit<InboundMessageStaging, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<InboundMessageStaging>;
      };
      conversations: {
        Row: Conversation;
        Insert: Omit<Conversation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Conversation>;
      };
      messages: {
        Row: Message;
        Insert: Omit<Message, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Message>;
      };
      failed_jobs: {
        Row: FailedJob;
        Insert: Omit<FailedJob, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<FailedJob>;
      };
      ai_draft_configs: {
        Row: AiDraftConfig;
        Insert: Omit<AiDraftConfig, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<AiDraftConfig>;
      };
      ai_drafts: {
        Row: AiDraft;
        Insert: Omit<AiDraft, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<AiDraft>;
      };
      ai_draft_revisions: {
        Row: AiDraftRevision;
        Insert: Omit<AiDraftRevision, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AiDraftRevision>;
      };
      ai_draft_review_events: {
        Row: AiDraftReviewEvent;
        Insert: Omit<AiDraftReviewEvent, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AiDraftReviewEvent>;
      };
      draft_generation_jobs: {
        Row: DraftGenerationJob;
        Insert: Omit<DraftGenerationJob, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftGenerationJob>;
      };
      draft_quota_limits: {
        Row: DraftQuotaLimit;
        Insert: Omit<DraftQuotaLimit, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftQuotaLimit>;
      };
      draft_usage_tracking: {
        Row: DraftUsageTracking;
        Insert: Omit<DraftUsageTracking, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftUsageTracking>;
      };
      draft_usage_reservations: {
        Row: DraftUsageReservation;
        Insert: Omit<DraftUsageReservation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftUsageReservation>;
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_organization_with_owner: {
        Args: {
          p_name: string;
          p_slug: string;
          p_owner_id: string;
        };
        Returns: string;
      };
      ingest_whatsapp_message_event: {
        Args: {
          p_provider_connection_identifier: string;
          p_provider: string;
          p_provider_event_key: string;
          p_event_kind: string;
          p_payload_sha256: string;
          p_provider_message_id: string;
          p_contact_identifier: string;
          p_message_kind: string;
          p_body_text: string;
          p_provider_timestamp: string;
          p_request_id: string;
        };
        Returns: { is_new: boolean; webhook_event_id: string };
      };
      process_inbound_message: {
        Args: {
          p_webhook_event_id: string;
        };
        Returns: {
          success: boolean;
          conversation_id: string | null;
          message_id: string | null;
          already_processed: boolean;
        };
      };
      archive_failed_job: {
        Args: {
          p_msg_id: string;
          p_request_id: string;
          p_error_code: string;
          p_attempts: number;
          p_webhook_event_id: string | null;
        };
        Returns: { archived: boolean; already_archived: boolean };
      };
      record_inbound_processing_failure: {
        Args: {
          p_webhook_event_id: string;
          p_error_code: string;
          p_attempt_count: number;
        };
        Returns: boolean;
      };
      read_whatsapp_inbound_jobs: {
        Args: {
          p_visibility_timeout_seconds: number;
          p_limit: number;
        };
        Returns: Array<{
          msg_id: string;
          read_ct: number;
          payload: Record<string, unknown>;
          enqueued_at: string;
          vt: string;
        }>;
      };
      delete_whatsapp_inbound_job: {
        Args: {
          p_msg_id: string;
        };
        Returns: boolean;
      };
      set_whatsapp_inbound_visibility: {
        Args: {
          p_msg_id: string;
          p_visibility_timeout_seconds: number;
        };
        Returns: boolean;
      };
      approve_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          reviewed_at: string | null;
          reviewed_by: string | null;
        };
      };
      edit_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
          p_body: string;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          current_revision_id: string | null;
        };
      };
      reject_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          rejected_at: string | null;
          rejected_by: string | null;
        };
      };
      /**
       * Returns the plaintext token exactly once. It is not stored and cannot
       * be recovered; a lost token means revoke and reissue.
       */
      create_invitation: {
        Args: {
          p_organization_id: string;
          p_email: string;
          p_role: OrganizationRole;
        };
        Returns: {
          invitation_id: string;
          token: string;
          email: string;
          role: OrganizationRole;
          expires_at: string;
        };
      };
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: { invitation_id: string; status: 'revoked' };
      };
      /**
       * Takes the PLAINTEXT token, not the stored hash. `role` is the role the
       * caller actually holds afterwards, which is not necessarily the invited
       * role: an existing membership is never rewritten.
       */
      accept_invitation: {
        Args: { p_token: string };
        Returns: {
          organization_id: string;
          membership_created: boolean;
          role: OrganizationRole;
        };
      };
      is_feature_enabled: {
        Args: {
          p_organization_id: string;
          p_flag_key: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      organization_role: OrganizationRole;
      invitation_status: InvitationStatus;
    };
  };
}
