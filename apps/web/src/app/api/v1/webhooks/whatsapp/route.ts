import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@tugpt/security';
import { createAdminSupabaseClient } from '@tugpt/database';
import { featureFlagService } from '@tugpt/feature-flags';
import { normalizeWhatsAppEnvelope, computeCanonicalHash } from '@/lib/whatsapp-normalizer';

const MAX_BODY_SIZE_BYTES = parseInt(
  process.env.WHATSAPP_MAX_BODY_SIZE_BYTES || '1048576',
  10
);
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

// GET: Webhook verification
export async function GET(request: NextRequest) {
  if (!featureFlagService.isEnabled('whatsapp_integration')) {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new NextResponse(challenge || '', { status: 200 });
  }

  return new NextResponse(null, { status: 403 });
}

// POST: Webhook event ingestion
export async function POST(request: NextRequest) {
  if (!featureFlagService.isEnabled('whatsapp_integration')) {
    return new NextResponse(null, { status: 404 });
  }

  // Validate content type
  const contentType = request.headers.get('content-type') || '';
  const parsedContentType = contentType.split(';')[0].trim();
  if (parsedContentType !== 'application/json') {
    return new NextResponse(null, { status: 415 });
  }

  // Read raw body
  let rawBody: Buffer;
  try {
    const text = await request.text();
    rawBody = Buffer.from(text, 'utf-8');
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Validate body size
  if (rawBody.length > MAX_BODY_SIZE_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // Validate signature
  const signatureHeader = request.headers.get('x-hub-signature-256');
  if (!signatureHeader) {
    return new NextResponse(null, { status: 401 });
  }

  if (!verifySignature(rawBody, signatureHeader, APP_SECRET)) {
    return new NextResponse(null, { status: 401 });
  }

  // Parse JSON
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Normalize envelope into individual events
  const events = normalizeWhatsAppEnvelope(payload);
  if (events.length === 0) {
    // Valid but unsupported event: acknowledge without persistence
    return new NextResponse(null, { status: 200 });
  }

  // Create admin client for RPC calls
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return new NextResponse(null, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminClient = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;

  // Ingest each event independently
  const requestId = request.headers.get('x-request-id') || null;
  for (const event of events) {
    const canonicalHash = computeCanonicalHash({
      provider: 'meta',
      providerConnectionIdentifier: event.providerConnectionIdentifier,
      providerMessageId: event.providerMessageId,
      contactIdentifier: event.contactIdentifier,
      messageKind: event.messageKind,
      bodyText: event.bodyText,
      providerTimestamp: event.providerTimestamp,
    });

    const { error } = await adminClient.rpc('ingest_whatsapp_message_event', {
      p_provider_connection_identifier: event.providerConnectionIdentifier,
      p_provider: 'meta',
      p_provider_event_key: event.providerMessageId,
      p_event_kind: 'message',
      p_payload_sha256: canonicalHash,
      p_provider_message_id: event.providerMessageId,
      p_contact_identifier: event.contactIdentifier,
      p_message_kind: event.messageKind,
      p_body_text: event.bodyText,
      p_provider_timestamp: event.providerTimestamp,
      p_request_id: requestId,
    });

    if (error) {
      // Any ingestion failure: return 500 for Meta retry
      return new NextResponse(null, { status: 500 });
    }
  }

  return new NextResponse(null, { status: 200 });
}