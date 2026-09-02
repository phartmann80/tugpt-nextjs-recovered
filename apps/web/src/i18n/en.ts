/**
 * English — a translation of `es.ts`, and typed as one.
 *
 * The annotation below is doing real work in both directions. A key present
 * here but not in Spanish is an excess-property error; a key missing here is a
 * missing-property error. Neither is a lint rule anyone has to remember to run.
 *
 * If you are adding a string, add it to `es.ts` first. That is not ceremony —
 * TypeScript will not let you do it in the other order.
 */

import type { Dictionary } from './types';

export const en: Dictionary = {
  'app.description': 'Your AI employee for WhatsApp, calls and customers.',

  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.reload': 'Reload',
  'common.previous': 'Previous',
  'common.next': 'Next',

  'shell.skipToContent': 'Skip to content',
  'shell.primaryNavLabel': 'Primary navigation',
  'shell.organizationLabel': 'Organization',
  'shell.organizationUnknown': 'Organization unavailable',
  'shell.signOut': 'Sign out',

  'nav.drafts': 'Drafts',
  'nav.inbox': 'Conversations',
  'inbox.title': 'Conversations',
  'inbox.loading': 'Loading conversations…',
  'inbox.loadFailed': 'Could not load the conversations',
  'inbox.empty': 'No conversations yet.',
  'inbox.emptyFiltered': 'No conversation matches this filter.',
  'inbox.retry': 'Retry',
  'inbox.next': 'Next',
  'inbox.start': 'Back to the start',
  'inbox.awaitingReview': 'Draft awaiting review',
  'inbox.lastActivity': 'Last activity: {at}',
  'inbox.unknownContact': 'Unknown contact',
  'inbox.filter.all': 'All',
  'inbox.filter.open': 'Open',
  'inbox.filter.needs_human': 'Needs attention',
  'inbox.filter.closed': 'Closed',

  'auth.login.title': 'Sign in to {app}',
  'auth.login.email': 'Email',
  'auth.login.emailPlaceholder': 'you@example.com',
  'auth.login.password': 'Password',
  'auth.login.passwordPlaceholder': '••••••••',
  'auth.login.submit': 'Sign in',
  'auth.login.submitting': 'Signing in…',
  'auth.logout.pending': 'Signing out…',
  'auth.callback.pending': 'Completing authentication…',

  'drafts.inbox.title': 'Draft inbox',
  'drafts.inbox.loading': 'Loading drafts…',
  'drafts.inbox.empty':
    'No drafts to review. AI-generated drafts will appear here.',
  'drafts.inbox.loadFailed': 'Could not load drafts',
  'drafts.inbox.noPreview': 'No preview available',
  'drafts.inbox.pagination': 'Page {page} of {pages}',

  'drafts.filter.all': 'All',
  'drafts.filter.draft': 'Drafts',
  'drafts.filter.approved': 'Approved',
  'drafts.filter.rejected': 'Rejected',

  'drafts.status.draft': 'Draft',
  'drafts.status.approved': 'Approved',
  'drafts.status.rejected': 'Rejected',

  'drafts.detail.title': 'Draft review',
  'drafts.detail.loading': 'Loading draft…',
  'drafts.detail.loadFailed': 'Could not load the draft',
  'drafts.detail.notFound': 'Draft not found.',
  'drafts.detail.backToInbox': 'Back to inbox',
  'drafts.detail.stale':
    'Another reviewer changed this draft. Reload before continuing.',
  'drafts.detail.version': 'Version: {version}',
  'drafts.detail.provider': 'Provider: {provider}',
  'drafts.detail.model': 'Model: {model}',
  'drafts.detail.created': 'Created: {at}',
  'drafts.detail.updated': 'Updated: {at}',
  'drafts.detail.reviewed': 'Reviewed: {at}',
  'drafts.detail.rejected': 'Rejected: {at}',
  'drafts.detail.contentHeading': 'Draft content',
  'drafts.detail.noContent': 'No content available',
  'drafts.detail.sourceHeading': 'Customer message',
  'drafts.detail.noSourceBody': 'The message has no text',
  'drafts.detail.direction': 'Direction: {direction}',
  'drafts.detail.received': 'Received: {at}',
  'drafts.detail.from': 'From: {contact}',
  'drafts.detail.conversationHeading': 'Conversation',
  'drafts.thread.heading': 'Conversation with the customer',
  'drafts.thread.loading': 'Loading the conversation…',
  'drafts.thread.loadFailed': 'Could not load the conversation',
  'drafts.thread.empty': 'No messages in this conversation yet.',
  'drafts.thread.olderHidden':
    'Showing the {count} most recent messages. There are older ones.',
  'drafts.thread.sourceOutOfWindow':
    'The message this draft answers is older than the messages shown here. It is above, under "Customer message".',
  'drafts.thread.sourceLabel': 'This draft answers this message',
  'drafts.thread.fromCustomer': 'Customer',
  'drafts.thread.fromBusiness': 'Business',
  'drafts.thread.noBody': 'Message has no text',
  'drafts.thread.retry': 'Retry',
  'drafts.detail.conversationStatus': 'Status: {status}',
  'drafts.detail.featureUnavailable':
    'AI draft generation is not available for your organization.',

  'drafts.direction.inbound': 'inbound',
  'drafts.direction.outbound': 'outbound',

  'drafts.conversation.open': 'open',
  'drafts.conversation.needs_human': 'needs a human',
  'drafts.conversation.closed': 'closed',

  'drafts.actions.approve': 'Approve',
  'drafts.actions.reject': 'Reject',
  'drafts.actions.edit': 'Edit',
  'drafts.actions.save': 'Save changes',
  'drafts.actions.saving': 'Saving…',
  'drafts.actions.processing': 'Processing…',
  'drafts.actions.editPlaceholder': 'Type the revised draft here…',
  'drafts.actions.emptyBody': 'The draft must not be empty',
  'drafts.actions.permissionDenied': 'You do not have permission to perform this action.',
  'drafts.actions.approveFailed': 'Could not approve the draft',
  'drafts.actions.rejectFailed': 'Could not reject the draft',
  'drafts.actions.editFailed': 'Could not save the edit',

  'drafts.revisions.heading': 'Revision history',
  'drafts.revisions.loadFailed': 'Could not load the revision history',
  'drafts.revisions.version': 'Version {version}',
  'drafts.revisions.current': '(current)',
  'drafts.revisions.byUser': 'Edited by a person',
  'drafts.revisions.byAi': 'AI generated',

  'drafts.events.heading': 'Review events',
  'drafts.events.loadFailed': 'Could not load the events',
  'drafts.events.approve': 'Approved',
  'drafts.events.edit': 'Edited',
  'drafts.events.reject': 'Rejected',

  'errors.UNAUTHENTICATED': 'Your session is not active. Please sign in again.',
  'errors.DRAFT_NOT_FOUND': 'Draft not found',
  'errors.FORBIDDEN': 'You do not have permission to perform this action',
  'errors.STALE_VERSION':
    'Another reviewer changed this draft. Reload and try again.',
  'errors.INVALID_STATE_TRANSITION': 'This draft cannot be modified in its current state',
  'errors.INVALID_BODY': 'The draft must not be empty',
  'errors.INVITATION_NOT_FOUND': 'Invitation not found',
  'errors.INVITATION_ALREADY_PENDING': 'That address already has a pending invitation. Revoke it before sending another.',
  'errors.INVITATION_NOT_PENDING': 'This invitation has already been used or withdrawn',
  'errors.INVITATION_EXPIRED': 'This invitation has expired. Ask for a new one.',
  'errors.INVITATION_WRONG_ACCOUNT': 'This invitation was sent to a different email address. Sign in with that address to accept it.',
  'errors.ALREADY_A_MEMBER': 'That person is already in this organization',
  'errors.ROLE_ABOVE_YOUR_OWN': 'You cannot invite someone at a role above your own',
  'errors.INVALID_EMAIL': 'That is not a valid email address',
  'errors.INTERNAL_ERROR': 'An unexpected error occurred',
};
