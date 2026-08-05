export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_locale: 'es' | 'en';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
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
  email: string;
  role: OrganizationRole;
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
        Insert: Omit<Organization, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Organization>;
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Omit<OrganizationMember, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationMember>;
      };
      organization_invitations: {
        Row: OrganizationInvitation;
        Insert: Omit<OrganizationInvitation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationInvitation>;
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
    };
    Enums: {
      organization_role: OrganizationRole;
      invitation_status: InvitationStatus;
    };
  };
}
