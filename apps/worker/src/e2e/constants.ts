/**
 * @file constants.ts
 * @description Fixed identifiers for the milestone #1 end-to-end harness.
 *
 * Every value here is deliberately, obviously synthetic. Nothing in this file
 * may ever resemble a real customer, a real phone number, or a real email
 * address — the harness writes to a live staging/production database, and the
 * only thing standing between it and real tenant data is that these constants
 * are unmistakable.
 *
 * `.invalid` is a reserved TLD (RFC 2606) and can never be registered, so the
 * reviewer address can never collide with or deliver to a real inbox.
 */

/** Slug of the one organization this harness is ever allowed to touch. */
export const ORG_SLUG = 'internal-e2e-test';

export const ORG_NAME = 'Internal E2E Test (synthetic - not a customer)';

export const BUSINESS_PROFILE_NAME = 'Internal E2E Test Business Profile';

/**
 * Stands in for a Meta phone_number_id. Meta IDs are numeric strings, so a
 * value with letters and hyphens can never collide with a real registered
 * number, and is immediately recognisable in the database as test data.
 */
export const PROVIDER_PHONE_NUMBER_ID = 'E2E-SYNTHETIC-PHONE-ID-DO-NOT-USE';

/** Business-side number. All-zero, never dialable. */
export const CONNECTION_PHONE = '+00000000000';

/** Customer-side number for the synthetic inbound message. */
export const CONTACT_PHONE = '+00000000001';

export const REVIEWER_EMAIL = 'e2e-reviewer@internal-e2e-test.invalid';

export const DRAFT_FLAG = 'ai_draft_generation';
export const WHATSAPP_FLAG = 'whatsapp_integration';

/** Quota ceiling seeded for the test org. Small on purpose. */
export const QUOTA_HARD_CEILING = 25;

/** The customer message the AI is asked to draft a reply to. */
export const SYNTHETIC_INBOUND_BODY =
  'Hallo, ich wollte fragen ob Sie diese Woche noch einen Termin frei haben?';

/** Body the harness writes when exercising the human-edit path. */
export const REVIEWER_EDIT_BODY =
  '[e2e-edited] This body was written by the milestone #1 harness to exercise the human-edit path.';
