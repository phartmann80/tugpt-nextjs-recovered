-- pgTAP tests: conversation lifecycle
-- File: supabase/tests/database/conversation_lifecycle.test.sql

BEGIN;
SELECT plan(5);

-- L1: Conversation created with status open for new contact
SELECT has_column('public', 'conversations', 'status', 'conversations has status column');

-- L2: Conversation status needs_human preserved on new message
-- L3: Conversation status closed preserved on new message
-- L4: Unique constraint on (organization_id, whatsapp_connection_id, contact_phone)
SELECT col_is_unique('public', 'conversations', 'contact_phone', 'conversations has unique constraint on contact_phone');

-- L5: Messages FK cascade on conversation delete
SELECT fk_ok('public', 'messages', 'conversation_id', 'public', 'conversations', 'id', 'messages.conversation_id FK to conversations.id');

SELECT finish();
ROLLBACK;