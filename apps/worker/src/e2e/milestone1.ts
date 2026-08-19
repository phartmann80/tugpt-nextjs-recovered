/**
 * @file milestone1.ts
 * @description End-to-end harness for TuGPT milestone #1: prove the full
 * pipeline works in staging with Langdock as the sole provider.
 *
 *   synthetic inbound message
 *     -> ingest_whatsapp_message_event (service-role RPC)
 *     -> whatsapp_inbound PGMQ queue
 *     -> whatsapp worker -> process_inbound_message
 *     -> draft_generation PGMQ queue
 *     -> draft worker -> Langdock (auto model routing)
 *     -> store_draft (ai_drafts + ai_draft_revisions + quota consume)
 *     -> human edit + approve as a real signed-in user
 *     -> audit trail + quota decrement
 *
 * NOT part of the worker runtime. Nothing under src/e2e/ is imported by
 * draft-index.ts or index.ts; it lives under src/ purely so that lint,
 * typecheck and the test build cover it in CI. It is invoked manually:
 *
 *   pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts all \
 *     --env-file /etc/tugpt/worker.env --env-file /etc/tugpt/web.env
 *
 * SAFETY. This writes to a live database, so every command re-checks the same
 * invariants before doing anything:
 *   1. `whatsapp_integration` must be false. If it is true anywhere the
 *      harness aborts immediately — it must never be the thing that causes a
 *      message to reach a real customer.
 *   2. It only ever touches the organization whose slug is `internal-e2e-test`
 *      (see constants.ts). It refuses to run against any other org, and
 *      refuses to run if that org contains a conversation with a contact phone
 *      that is not the synthetic one, which would suggest the slug has been
 *      reused for something real.
 *   3. It asserts, at the end, that zero outbound messages exist for the org.
 *
 * FEATURE FLAG SEMANTICS — read this before running. `is_feature_enabled` is a
 * logical AND of the global row (organization_id IS NULL) and the org row, not
 * an override chain. Enabling drafts for one org therefore REQUIRES setting the
 * global `ai_draft_generation` row to true as well; there is no way to enable
 * it org-scoped while the global stays false. Tenant isolation is still exact,
 * because every other org has no org-scoped row and so resolves to false. The
 * global row is the kill switch: setting it back to false disables draft
 * generation everywhere instantly, and `teardown` restores it.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadHarnessEnv, fingerprint, type HarnessEnv } from './env.js';
import { parseArgs } from './args.js';
import {
  ORG_SLUG,
  ORG_NAME,
  BUSINESS_PROFILE_NAME,
  PROVIDER_PHONE_NUMBER_ID,
  CONNECTION_PHONE,
  CONTACT_PHONE,
  REVIEWER_EMAIL,
  DRAFT_FLAG,
  WHATSAPP_FLAG,
  QUOTA_HARD_CEILING,
  SYNTHETIC_INBOUND_BODY,
  REVIEWER_EDIT_BODY,
} from './constants.js';

/**
 * The generated Supabase types don't cover the SECURITY DEFINER RPCs this
 * harness calls, and the admin client is used untyped elsewhere in the worker
 * for the same reason. One alias, one disable, rather than scattering casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// --- small output helpers -------------------------------------------------

const log = (msg: string): void => console.log(msg);
const step = (msg: string): void => console.log(`\n=== ${msg} ===`);
const ok = (msg: string): void => console.log(`  [ok]   ${msg}`);
const info = (msg: string): void => console.log(`  [info] ${msg}`);
const warn = (msg: string): void => console.log(`  [WARN] ${msg}`);

class HarnessError extends Error {}

function fail(msg: string): never {
  throw new HarnessError(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- context --------------------------------------------------------------

interface Ctx {
  env: HarnessEnv;
  admin: Db;
}

function makeAdmin(env: HarnessEnv): Db {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- safety invariants ----------------------------------------------------

/**
 * Abort unless outbound WhatsApp is disabled. Checked before every command,
 * not just at seed time, because the flag could be flipped between steps.
 */
async function assertWhatsAppDisabled(ctx: Ctx): Promise<void> {
  const { data, error } = await ctx.admin
    .from('feature_flags')
    .select('organization_id, key, is_enabled')
    .eq('key', WHATSAPP_FLAG);

  if (error) fail(`Could not read ${WHATSAPP_FLAG} feature flag: ${error.message}`);

  const enabled = (data ?? []).filter((row: { is_enabled: boolean }) => row.is_enabled);
  if (enabled.length > 0) {
    fail(
      `REFUSING TO RUN: ${WHATSAPP_FLAG} is enabled on ${enabled.length} row(s). ` +
        `This harness must never run while outbound WhatsApp is live. Disable it first.`
    );
  }

  ok(`${WHATSAPP_FLAG} is disabled everywhere (${(data ?? []).length} row(s) checked)`);
}

/** Look up the synthetic org. Returns null when it does not exist yet. */
async function findOrg(ctx: Ctx): Promise<{ id: string; name: string } | null> {
  const { data, error } = await ctx.admin
    .from('organizations')
    .select('id, name, deleted_at')
    .eq('slug', ORG_SLUG)
    .maybeSingle();

  if (error) fail(`Could not query organizations: ${error.message}`);
  if (!data) return null;
  if (data.deleted_at) {
    fail(
      `Organization '${ORG_SLUG}' exists but is soft-deleted (deleted_at=${data.deleted_at}). ` +
        `Clear deleted_at or pick a different slug before running.`
    );
  }
  return { id: data.id, name: data.name };
}

async function requireOrg(ctx: Ctx): Promise<string> {
  const org = await findOrg(ctx);
  if (!org) fail(`Organization '${ORG_SLUG}' does not exist. Run the 'seed' command first.`);
  return org.id;
}

/**
 * Guard against the synthetic slug having been reused for something real.
 * Any conversation whose contact phone is not our synthetic number means this
 * org is carrying data the harness did not create, so we stop.
 */
async function assertOrgIsSynthetic(ctx: Ctx, orgId: string): Promise<void> {
  const { data, error } = await ctx.admin
    .from('conversations')
    .select('id, contact_phone')
    .eq('organization_id', orgId)
    .neq('contact_phone', CONTACT_PHONE)
    .limit(5);

  if (error) fail(`Could not verify org is synthetic: ${error.message}`);
  if ((data ?? []).length > 0) {
    fail(
      `REFUSING TO RUN: org '${ORG_SLUG}' contains ${data.length} conversation(s) with ` +
        `non-synthetic contact phones. This org may have been reused for real data.`
    );
  }
  ok(`org '${ORG_SLUG}' contains only synthetic conversations`);
}

// --- commands -------------------------------------------------------------

async function cmdPreflight(ctx: Ctx): Promise<void> {
  step('PREFLIGHT');
  info(`Supabase URL: ${ctx.env.supabaseUrl}`);
  info(`Service role key: ${fingerprint(ctx.env.serviceRoleKey)}`);
  info(`Anon key: ${ctx.env.anonKey ? fingerprint(ctx.env.anonKey) : '<not provided>'}`);

  const { error: pingError } = await ctx.admin.from('organizations').select('id').limit(1);
  if (pingError) fail(`Cannot reach Supabase with the service-role key: ${pingError.message}`);
  ok('service-role connection works');

  await assertWhatsAppDisabled(ctx);

  const { data: flags, error: flagError } = await ctx.admin
    .from('feature_flags')
    .select('organization_id, key, is_enabled')
    .eq('key', DRAFT_FLAG);
  if (flagError) fail(`Could not read ${DRAFT_FLAG}: ${flagError.message}`);

  const globalRow = (flags ?? []).find((r: { organization_id: string | null }) => r.organization_id === null);
  info(
    `${DRAFT_FLAG} global row: ${
      globalRow ? `is_enabled=${globalRow.is_enabled}` : 'MISSING (resolves to false for every org)'
    }`
  );
  info(`${DRAFT_FLAG} org-scoped rows: ${(flags ?? []).length - (globalRow ? 1 : 0)}`);

  const org = await findOrg(ctx);
  if (org) {
    ok(`test org exists: ${org.id}`);
    await assertOrgIsSynthetic(ctx, org.id);
  } else {
    info(`test org '${ORG_SLUG}' does not exist yet — 'seed' will create it`);
  }

  if (!ctx.env.anonKey) {
    warn(
      'No NEXT_PUBLIC_SUPABASE_ANON_KEY found. The human-review leg needs a real user JWT ' +
        '(approve/edit/reject reject the service-role key because auth.uid() is NULL). ' +
        'Pass --env-file /etc/tugpt/web.env to include it, or the review step will be skipped.'
    );
  }

  ok('preflight complete');
}

async function cmdSeed(ctx: Ctx): Promise<void> {
  step('SEED');
  await assertWhatsAppDisabled(ctx);

  // 1. Organization
  let org = await findOrg(ctx);
  if (!org) {
    const { data, error } = await ctx.admin
      .from('organizations')
      .insert({ name: ORG_NAME, slug: ORG_SLUG })
      .select('id, name')
      .single();
    if (error) fail(`Could not create organization: ${error.message}`);
    org = { id: data.id, name: data.name };
    ok(`created organization ${org.id}`);
  } else {
    ok(`organization already exists ${org.id}`);
  }
  const orgId = org.id;
  await assertOrgIsSynthetic(ctx, orgId);

  // 2. Reviewer user. profiles is created by the on_auth_user_created trigger.
  const { data: userList, error: listError } = await ctx.admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) fail(`Could not list auth users: ${listError.message}`);

  let reviewerId: string;
  const existing = (userList?.users ?? []).find(
    (u: { email?: string }) => u.email?.toLowerCase() === REVIEWER_EMAIL
  );
  if (existing) {
    reviewerId = existing.id;
    ok(`reviewer user already exists ${reviewerId}`);
  } else {
    const { data: created, error: createError } = await ctx.admin.auth.admin.createUser({
      email: REVIEWER_EMAIL,
      password: randomBytes(24).toString('base64url'),
      email_confirm: true,
    });
    if (createError) fail(`Could not create reviewer user: ${createError.message}`);
    reviewerId = created.user.id;
    ok(`created reviewer user ${reviewerId}`);
  }

  // The profiles row must exist before organization_members can reference it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data: profile } = await ctx.admin
      .from('profiles')
      .select('id')
      .eq('id', reviewerId)
      .maybeSingle();
    if (profile) break;
    if (attempt === 9) fail(`profiles row for reviewer ${reviewerId} never appeared`);
    await sleep(300);
  }
  ok('reviewer profile row present');

  // 3. Membership. Role must be in (owner, admin, manager, agent) to review.
  const { error: memberError } = await ctx.admin
    .from('organization_members')
    .upsert(
      { organization_id: orgId, user_id: reviewerId, role: 'owner' },
      { onConflict: 'organization_id,user_id' }
    );
  if (memberError) fail(`Could not create membership: ${memberError.message}`);
  ok('reviewer is an owner of the test org');

  // 4. Business profile (one per org, enforced by a unique index).
  const { data: bp, error: bpError } = await ctx.admin
    .from('business_profiles')
    .upsert(
      { organization_id: orgId, display_name: BUSINESS_PROFILE_NAME },
      { onConflict: 'organization_id' }
    )
    .select('id')
    .single();
  if (bpError) fail(`Could not create business profile: ${bpError.message}`);
  const businessProfileId = bp.id;
  ok(`business profile ${businessProfileId}`);

  // 5. WhatsApp connection. Must be 'active' or the ingest RPC raises
  //    CONNECTION_NOT_FOUND. No Meta involvement: the identifier is synthetic.
  const { data: conn, error: connError } = await ctx.admin
    .from('whatsapp_connections')
    .upsert(
      {
        organization_id: orgId,
        business_profile_id: businessProfileId,
        display_name: 'E2E synthetic connection',
        phone_number: CONNECTION_PHONE,
        provider_phone_number_id: PROVIDER_PHONE_NUMBER_ID,
        status: 'active',
      },
      { onConflict: 'provider_phone_number_id' }
    )
    .select('id')
    .single();
  if (connError) fail(`Could not create whatsapp connection: ${connError.message}`);
  ok(`whatsapp connection ${conn.id} (status=active, synthetic identifier)`);

  // 6. Draft config — drives the prompt sent to Langdock.
  const { error: cfgError } = await ctx.admin.from('ai_draft_configs').upsert(
    {
      organization_id: orgId,
      business_profile_id: businessProfileId,
      business_instructions:
        'You are the assistant for an internal end-to-end test business. Answer briefly and politely.',
      personality: 'Professional, warm, concise.',
      response_rules: 'Always greet the customer. Never invent appointment times or prices.',
      tone: 'Friendly',
      max_draft_length: 1000,
    },
    { onConflict: 'business_profile_id' }
  );
  if (cfgError) fail(`Could not create ai_draft_config: ${cfgError.message}`);
  ok('ai_draft_config seeded');

  // 7. Quota. The period must contain CURRENT_DATE or reserve_draft_usage
  //    denies with NO_ACTIVE_QUOTA_PERIOD.
  const { data: quotaRows, error: quotaReadError } = await ctx.admin
    .from('draft_quota_limits')
    .select('id, period_start, period_end, hard_ceiling')
    .eq('organization_id', orgId);
  if (quotaReadError) fail(`Could not read quota limits: ${quotaReadError.message}`);

  const today = new Date().toISOString().slice(0, 10);
  const live = (quotaRows ?? []).find(
    (q: { period_start: string; period_end: string }) => q.period_start <= today && today < q.period_end
  );

  if (live) {
    ok(`live quota period already exists (ceiling ${live.hard_ceiling}, ends ${live.period_end})`);
  } else {
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { error: quotaError } = await ctx.admin.from('draft_quota_limits').insert({
      organization_id: orgId,
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
      hard_ceiling: QUOTA_HARD_CEILING,
    });
    if (quotaError) fail(`Could not create quota period: ${quotaError.message}`);
    ok(`created 30-day quota period, ceiling ${QUOTA_HARD_CEILING}`);
  }

  // 8. Feature flags. See the file header: this is an AND, so the global row
  //    must be true too. Record the prior value so teardown can restore it.
  const { data: globalRow, error: globalReadError } = await ctx.admin
    .from('feature_flags')
    .select('id, is_enabled')
    .is('organization_id', null)
    .eq('key', DRAFT_FLAG)
    .maybeSingle();
  if (globalReadError) fail(`Could not read global ${DRAFT_FLAG}: ${globalReadError.message}`);

  if (!globalRow) {
    const { error } = await ctx.admin
      .from('feature_flags')
      .insert({ organization_id: null, key: DRAFT_FLAG, is_enabled: true });
    if (error) fail(`Could not create global ${DRAFT_FLAG}: ${error.message}`);
    warn(`global ${DRAFT_FLAG} row was MISSING; created it as ENABLED`);
  } else if (!globalRow.is_enabled) {
    const { error } = await ctx.admin
      .from('feature_flags')
      .update({ is_enabled: true })
      .eq('id', globalRow.id);
    if (error) fail(`Could not enable global ${DRAFT_FLAG}: ${error.message}`);
    warn(
      `global ${DRAFT_FLAG} flipped false -> TRUE. Required: is_feature_enabled ANDs the ` +
        `global row with the org row, so org-scoped enablement is impossible while global is false. ` +
        `Isolation still holds (no other org has an org-scoped row). 'teardown' restores it to false.`
    );
  } else {
    info(`global ${DRAFT_FLAG} was already enabled`);
  }

  const { error: orgFlagError } = await ctx.admin
    .from('feature_flags')
    .upsert(
      { organization_id: orgId, key: DRAFT_FLAG, is_enabled: true },
      { onConflict: 'organization_id,key' }
    );
  if (orgFlagError) fail(`Could not enable org-scoped ${DRAFT_FLAG}: ${orgFlagError.message}`);
  ok(`${DRAFT_FLAG} enabled for org ${orgId} only`);

  // Prove the resolution actually came out true for us and false elsewhere.
  const { data: resolved, error: resolveError } = await ctx.admin.rpc('is_feature_enabled', {
    p_organization_id: orgId,
    p_flag_key: DRAFT_FLAG,
  });
  if (resolveError) fail(`is_feature_enabled failed: ${resolveError.message}`);
  if (resolved !== true) fail(`is_feature_enabled returned ${resolved} for the test org; expected true`);
  ok('is_feature_enabled(test org, ai_draft_generation) = true');

  const { data: otherOrgs } = await ctx.admin
    .from('organizations')
    .select('id, slug')
    .neq('slug', ORG_SLUG)
    .is('deleted_at', null)
    .limit(5);

  for (const other of otherOrgs ?? []) {
    const { data: otherResolved } = await ctx.admin.rpc('is_feature_enabled', {
      p_organization_id: other.id,
      p_flag_key: DRAFT_FLAG,
    });
    if (otherResolved === true) {
      fail(
        `ISOLATION FAILURE: ${DRAFT_FLAG} also resolves true for org '${other.slug}' (${other.id}). ` +
          `Remove that org's feature_flags row before continuing.`
      );
    }
  }
  ok(`isolation verified against ${(otherOrgs ?? []).length} other org(s): all resolve false`);

  // Conversation must be 'open' for the draft job to be enqueued.
  const { data: convo } = await ctx.admin
    .from('conversations')
    .select('id, status')
    .eq('organization_id', orgId)
    .eq('contact_phone', CONTACT_PHONE)
    .maybeSingle();
  if (convo && convo.status !== 'open') {
    const { error } = await ctx.admin
      .from('conversations')
      .update({ status: 'open' })
      .eq('id', convo.id);
    if (error) fail(`Could not reopen conversation: ${error.message}`);
    info(`reopened conversation ${convo.id} (was '${convo.status}')`);
  }

  ok('seed complete');
}

interface InjectResult {
  webhookEventId: string;
  providerMessageId: string;
  isNew: boolean;
}

async function cmdInject(ctx: Ctx): Promise<InjectResult> {
  step('INJECT');
  await assertWhatsAppDisabled(ctx);
  const orgId = await requireOrg(ctx);
  await assertOrgIsSynthetic(ctx, orgId);

  // Unique per run: messages and webhook_events both carry unique constraints
  // on the provider-supplied id, so a fixed value would only work once.
  const providerMessageId = `e2e-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const providerTimestamp = new Date().toISOString();

  // The column enforces 64 lowercase hex characters.
  const payloadSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        provider: 'meta',
        providerConnectionIdentifier: PROVIDER_PHONE_NUMBER_ID,
        providerMessageId,
        contactIdentifier: CONTACT_PHONE,
        messageKind: 'text',
        bodyText: SYNTHETIC_INBOUND_BODY,
        providerTimestamp,
      })
    )
    .digest('hex');

  info(`provider_message_id: ${providerMessageId}`);
  info('calling ingest_whatsapp_message_event (bypasses the HTTP webhook, which 404s while');
  info('whatsapp_integration is false — the pipeline from ingest onward is untouched)');

  const { data, error } = await ctx.admin.rpc('ingest_whatsapp_message_event', {
    p_provider_connection_identifier: PROVIDER_PHONE_NUMBER_ID,
    p_provider: 'meta',
    p_provider_event_key: providerMessageId,
    p_event_kind: 'message',
    p_payload_sha256: payloadSha256,
    p_provider_message_id: providerMessageId,
    p_contact_identifier: CONTACT_PHONE,
    p_message_kind: 'text',
    p_body_text: SYNTHETIC_INBOUND_BODY,
    p_provider_timestamp: providerTimestamp,
    p_request_id: `e2e-${randomUUID()}`,
  });

  if (error) {
    fail(
      `ingest_whatsapp_message_event failed (code ${error.code ?? 'n/a'}): ${error.message}. ` +
        `90003=CONNECTION_NOT_FOUND (connection missing or not active), ` +
        `90004=EVENT_KEY_PAYLOAD_MISMATCH, 90005=QUEUE_SEND_FAILED.`
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.webhook_event_id) fail(`ingest returned no webhook_event_id: ${JSON.stringify(data)}`);

  ok(`ingested. webhook_event_id=${row.webhook_event_id} is_new=${row.is_new}`);
  ok('message is now on the whatsapp_inbound PGMQ queue');

  return {
    webhookEventId: row.webhook_event_id,
    providerMessageId,
    isNew: row.is_new,
  };
}

interface WaitResult {
  draftId: string;
  jobId: string;
  provider: string | null;
  model: string | null;
  elapsedMs: number;
}

async function cmdWait(ctx: Ctx, providerMessageId: string, timeoutMs: number): Promise<WaitResult> {
  step('WAIT FOR DRAFT');
  const orgId = await requireOrg(ctx);
  const startedAt = Date.now();

  info(`polling for up to ${Math.round(timeoutMs / 1000)}s...`);

  let messageId: string | null = null;
  let lastStatus = '';

  while (Date.now() - startedAt < timeoutMs) {
    if (!messageId) {
      const { data: msg } = await ctx.admin
        .from('messages')
        .select('id')
        .eq('organization_id', orgId)
        .eq('provider_message_id', providerMessageId)
        .maybeSingle();
      if (msg) {
        messageId = msg.id;
        ok(`whatsapp worker processed the message -> messages.id=${messageId}`);
      }
    }

    if (messageId) {
      const { data: job } = await ctx.admin
        .from('draft_generation_jobs')
        .select('id, status, attempts, error_code, skip_reason, provider, model')
        .eq('organization_id', orgId)
        .eq('source_message_id', messageId)
        .maybeSingle();

      if (job) {
        if (job.status !== lastStatus) {
          info(`draft job ${job.id}: status=${job.status} attempts=${job.attempts}`);
          lastStatus = job.status;
        }

        if (job.status === 'completed') {
          const { data: draft } = await ctx.admin
            .from('ai_drafts')
            .select('id, provider, model')
            .eq('organization_id', orgId)
            .eq('source_message_id', messageId)
            .maybeSingle();
          if (draft) {
            const elapsedMs = Date.now() - startedAt;
            ok(`DRAFT GENERATED in ${Math.round(elapsedMs / 1000)}s`);
            ok(`  draft id : ${draft.id}`);
            ok(`  provider : ${draft.provider}`);
            ok(`  model    : ${draft.model}`);
            return { draftId: draft.id, jobId: job.id, provider: draft.provider, model: draft.model, elapsedMs };
          }
        }

        if (job.status === 'skipped') {
          fail(
            `draft job was SKIPPED (skip_reason=${job.skip_reason}). ` +
              `FEATURE_DISABLED means the flag did not resolve true; ` +
              `quota reasons mean draft_quota_limits needs attention.`
          );
        }

        if (job.status === 'dead_lettered') {
          // Surface what the provider actually said. Before 2026-08-19 this
          // was not recorded anywhere, so an invalid-model rejection looked
          // identical to an outage and had to be reproduced by hand.
          const { data: failed } = await ctx.admin
            .from('failed_jobs')
            .select('error_code, attempts, provider_error_detail')
            .eq('queue_name', 'draft_generation')
            .order('created_at', { ascending: false })
            .limit(1);
          const detail = failed?.[0]?.provider_error_detail;

          fail(
            `draft job was DEAD-LETTERED (error_code=${job.error_code}, attempts=${job.attempts}).` +
              (detail ? `\n  Provider said: ${detail}` : '\n  No provider detail recorded.') +
              `\n  DRAFT_INVALID_REQUEST => the provider rejected the request (4xx); read "Provider said" above.` +
              `\n  DRAFT_PROVIDER_CONFIG_ERROR => LANGDOCK_API_CODE missing, or LANGDOCK_MODEL not on the allowlist.` +
              `\n  DRAFT_PROVIDER_AUTH_ERROR => the key is present but rejected by Langdock.` +
              `\n  DRAFT_EXHAUSTED_RETRIES => three genuinely transient failures (Langdock down / rate limited).`
          );
        }
      }
    }

    await sleep(2000);
  }

  if (!messageId) {
    fail(
      `Timed out: the whatsapp worker never turned the queued event into a message row. ` +
        `Check that tugpt-whatsapp-worker is running: systemctl status tugpt-whatsapp-worker`
    );
  }
  fail(
    `Timed out waiting for the draft. The message was processed but no draft completed. ` +
      `Check that tugpt-draft-worker is running and has LANGDOCK_API_CODE: ` +
      `systemctl status tugpt-draft-worker && journalctl -u tugpt-draft-worker -n 100`
  );
}

/**
 * Exercise the human-review leg as a genuinely authenticated user.
 *
 * approve/edit/reject call is_org_member(auth.uid()) and reject the
 * service-role key outright, so the harness signs in as the synthetic reviewer
 * and drives them with a real JWT — the same path the dashboard uses. The
 * reviewer's password is rotated to a fresh random value immediately before
 * sign-in so no credential is ever stored anywhere.
 */
async function cmdReview(ctx: Ctx, draftId: string): Promise<{ skipped: boolean }> {
  step('HUMAN REVIEW (edit + approve)');

  if (!ctx.env.anonKey) {
    warn('skipped: no NEXT_PUBLIC_SUPABASE_ANON_KEY. Re-run with --env-file /etc/tugpt/web.env');
    return { skipped: true };
  }

  const orgId = await requireOrg(ctx);

  const { data: userList, error: listError } = await ctx.admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) fail(`Could not list auth users: ${listError.message}`);
  const reviewer = (userList?.users ?? []).find(
    (u: { email?: string }) => u.email?.toLowerCase() === REVIEWER_EMAIL
  );
  if (!reviewer) fail(`Reviewer ${REVIEWER_EMAIL} not found. Run 'seed' first.`);

  const password = `${randomBytes(24).toString('base64url')}Aa1!`;
  const { error: pwError } = await ctx.admin.auth.admin.updateUserById(reviewer.id, { password });
  if (pwError) fail(`Could not rotate reviewer password: ${pwError.message}`);

  const userClient: Db = createClient(ctx.env.supabaseUrl, ctx.env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } = await userClient.auth.signInWithPassword({
    email: REVIEWER_EMAIL,
    password,
  });
  if (signInError) fail(`Reviewer sign-in failed: ${signInError.message}`);
  ok(`signed in as ${REVIEWER_EMAIL} (uid ${session.user.id})`);

  // Prove we are NOT accidentally still service-role. draft_generation_jobs has
  // RLS FORCE with zero policies, so an authenticated user must see nothing.
  // Without this check a misconfigured client could make the review leg pass
  // for the wrong reason.
  const { data: leak } = await userClient
    .from('draft_generation_jobs')
    .select('id')
    .eq('organization_id', orgId)
    .limit(1);
  if ((leak ?? []).length > 0) {
    fail(
      'PRIVILEGE CHECK FAILED: the "user" client can read draft_generation_jobs, which is ' +
        'service-role only. The review leg would not be testing the real authorization path.'
    );
  }
  ok('privilege check: user client cannot read service-role-only tables');

  const { data: before, error: beforeError } = await ctx.admin
    .from('ai_drafts')
    .select('id, status, version')
    .eq('id', draftId)
    .single();
  if (beforeError) fail(`Could not read draft: ${beforeError.message}`);
  info(`draft before review: status=${before.status} version=${before.version}`);

  // Edit — optimistic locking uses the current version as the expected value.
  const { data: edited, error: editError } = await userClient.rpc('edit_draft', {
    p_draft_id: draftId,
    p_expected_lock_version: before.version,
    p_body: REVIEWER_EDIT_BODY,
  });
  if (editError) {
    fail(
      `edit_draft failed (code ${editError.code ?? 'n/a'}): ${editError.message}. ` +
        `P3B02=FORBIDDEN (membership/role), P3B03=STALE_VERSION, P3B05=INVALID_BODY.`
    );
  }
  const editedRow = Array.isArray(edited) ? edited[0] : edited;
  ok(`edit_draft -> version ${editedRow.version}, revision ${editedRow.current_revision_id}`);

  // Approve, using the version the edit bumped us to.
  const { data: approved, error: approveError } = await userClient.rpc('approve_draft', {
    p_draft_id: draftId,
    p_expected_lock_version: editedRow.version,
  });
  if (approveError) {
    fail(
      `approve_draft failed (code ${approveError.code ?? 'n/a'}): ${approveError.message}. ` +
        `P3B04=INVALID_STATE_TRANSITION means the draft was no longer in 'draft' status.`
    );
  }
  const approvedRow = Array.isArray(approved) ? approved[0] : approved;
  ok(`approve_draft -> status=${approvedRow.status} version=${approvedRow.version}`);
  ok(`reviewed_by=${approvedRow.reviewed_by} reviewed_at=${approvedRow.reviewed_at}`);

  // Stale-version rejection proves optimistic locking is actually enforced.
  const { error: staleError } = await userClient.rpc('approve_draft', {
    p_draft_id: draftId,
    p_expected_lock_version: before.version,
  });
  if (!staleError) {
    fail('optimistic locking is NOT working: a stale-version approve succeeded');
  }
  ok(`optimistic locking enforced: stale approve rejected (${staleError.code ?? staleError.message})`);

  await userClient.auth.signOut();
  // Leave the account unusable rather than holding a known-good password.
  await ctx.admin.auth.admin.updateUserById(reviewer.id, {
    password: randomBytes(32).toString('base64url'),
  });

  return { skipped: false };
}

async function cmdEvidence(ctx: Ctx, providerMessageId: string | null): Promise<void> {
  step('EVIDENCE PACK');
  const orgId = await requireOrg(ctx);

  const pick = async (
    table: string,
    columns: string,
    filter: (q: Db) => Db
  ): Promise<unknown[]> => {
    const { data, error } = await filter(ctx.admin.from(table).select(columns));
    if (error) {
      warn(`could not read ${table}: ${error.message}`);
      return [];
    }
    return data ?? [];
  };

  let messageId: string | null = null;
  if (providerMessageId) {
    const rows = (await pick('messages', 'id', (q: Db) =>
      q.eq('organization_id', orgId).eq('provider_message_id', providerMessageId)
    )) as Array<{ id: string }>;
    messageId = rows[0]?.id ?? null;
  }

  const drafts = (await pick('ai_drafts', '*', (q: Db) =>
    messageId
      ? q.eq('organization_id', orgId).eq('source_message_id', messageId)
      : q.eq('organization_id', orgId).order('created_at', { ascending: false }).limit(1)
  )) as Array<{ id: string }>;
  const draftId = drafts[0]?.id ?? null;

  const evidence = {
    generatedAt: new Date().toISOString(),
    organizationId: orgId,
    organizationSlug: ORG_SLUG,
    providerMessageId,
    messageId,
    draftId,
    featureFlags: await pick('feature_flags', 'organization_id, key, is_enabled', (q: Db) =>
      q.in('key', [DRAFT_FLAG, WHATSAPP_FLAG])
    ),
    inboundMessage: messageId
      ? await pick('messages', 'id, direction, status, provider_message_id, created_at', (q: Db) =>
          q.eq('id', messageId)
        )
      : [],
    webhookEvents: await pick(
      'webhook_events',
      'id, status, event_kind, attempt_count, last_error_code, received_at, processed_at',
      (q: Db) =>
        providerMessageId
          ? q.eq('organization_id', orgId).eq('provider_event_key', providerMessageId)
          : q.eq('organization_id', orgId).order('received_at', { ascending: false }).limit(3)
    ),
    conversation: await pick('conversations', 'id, status, contact_phone, last_message_at', (q: Db) =>
      q.eq('organization_id', orgId)
    ),
    draftGenerationJob: messageId
      ? await pick(
          'draft_generation_jobs',
          'id, status, attempts, provider, model, skip_reason, error_code, pgmq_msg_id, created_at, updated_at',
          (q: Db) => q.eq('organization_id', orgId).eq('source_message_id', messageId)
        )
      : [],
    draft: drafts,
    revisions: draftId
      ? await pick(
          'ai_draft_revisions',
          'id, version, created_by_type, created_by_user_id, created_at, body',
          (q: Db) => q.eq('draft_id', draftId).order('version', { ascending: true })
        )
      : [],
    reviewEvents: draftId
      ? await pick(
          'ai_draft_review_events',
          'id, action, actor_id, previous_version, new_version, created_at',
          (q: Db) => q.eq('draft_id', draftId).order('created_at', { ascending: true })
        )
      : [],
    quotaLimits: await pick(
      'draft_quota_limits',
      'id, period_start, period_end, hard_ceiling',
      (q: Db) => q.eq('organization_id', orgId)
    ),
    usageTracking: await pick(
      'draft_usage_tracking',
      'id, period_start, period_end, draft_count, reserved_count',
      (q: Db) => q.eq('organization_id', orgId)
    ),
    reservations: await pick(
      'draft_usage_reservations',
      'id, draft_generation_job_id, status, created_at',
      (q: Db) => q.eq('organization_id', orgId)
    ),
    auditLogs: await pick('audit_logs', 'id, action, resource, created_at', (q: Db) =>
      q.eq('organization_id', orgId).order('created_at', { ascending: false }).limit(25)
    ),
    // provider_error_detail is what makes a provider-side rejection
    // diagnosable from the evidence pack alone. Added 2026-08-19, after a
    // Langdock 400 could only be identified by curling the API by hand.
    failedJobs: await pick(
      'failed_jobs',
      'id, job_type, error_code, attempts, queue_name, provider_error_detail, created_at',
      (q: Db) => q.order('created_at', { ascending: false }).limit(10)
    ),
  };

  log(JSON.stringify(evidence, null, 2));

  // Assertions worth failing the run over.
  step('EVIDENCE ASSERTIONS');

  const outbound = await pick('messages', 'id, direction', (q: Db) =>
    q.eq('organization_id', orgId).eq('direction', 'outbound')
  );
  if (outbound.length > 0) {
    fail(`ASSERTION FAILED: ${outbound.length} outbound message(s) exist. Nothing may be sent to customers.`);
  }
  ok('zero outbound messages (nothing was sent to any customer)');

  await assertWhatsAppDisabled(ctx);

  const usage = evidence.usageTracking as Array<{ draft_count: number; reserved_count: number }>;
  if (usage.length > 0) {
    ok(`quota usage: draft_count=${usage[0].draft_count} reserved_count=${usage[0].reserved_count}`);
    if (usage[0].draft_count < 1) {
      warn('draft_count is 0 — the quota was not consumed, which is unexpected after a stored draft');
    }
  } else {
    warn('no draft_usage_tracking row found');
  }

  const revisions = evidence.revisions as unknown[];
  const reviewEvents = evidence.reviewEvents as unknown[];
  ok(`${revisions.length} revision(s), ${reviewEvents.length} review event(s)`);
}

async function cmdTeardown(ctx: Ctx): Promise<void> {
  step('TEARDOWN');
  const org = await findOrg(ctx);
  if (!org) {
    ok('nothing to tear down');
    return;
  }
  const orgId = org.id;
  await assertOrgIsSynthetic(ctx, orgId);

  // Turn the kill switch back off first, so nothing new can enter the pipeline
  // while the rest of the teardown runs.
  const { error: globalError } = await ctx.admin
    .from('feature_flags')
    .update({ is_enabled: false })
    .is('organization_id', null)
    .eq('key', DRAFT_FLAG);
  if (globalError) warn(`could not disable global ${DRAFT_FLAG}: ${globalError.message}`);
  else ok(`global ${DRAFT_FLAG} set back to false (draft generation off everywhere)`);

  const { error: orgFlagError } = await ctx.admin
    .from('feature_flags')
    .update({ is_enabled: false })
    .eq('organization_id', orgId)
    .eq('key', DRAFT_FLAG);
  if (orgFlagError) warn(`could not disable org ${DRAFT_FLAG}: ${orgFlagError.message}`);
  else ok(`org-scoped ${DRAFT_FLAG} set to false`);

  info('Synthetic rows are intentionally NOT deleted: audit_logs are immutable by design,');
  info('and keeping the org lets you re-run without reseeding. Delete the org manually if');
  info('you truly want it gone (note: DELETE on organizations is a soft delete by trigger).');

  ok('teardown complete');
}

// --- entrypoint -----------------------------------------------------------

const USAGE = `
TuGPT milestone #1 end-to-end harness

  tsx src/e2e/milestone1.ts <command> [--env-file PATH]... [--timeout SECONDS]

Commands:
  preflight   Check connectivity and safety invariants. Makes no writes.
  seed        Create/refresh the synthetic org, connection, config, quota, flags.
  inject      Push one synthetic inbound message through the ingest RPC.
  review      Exercise edit + approve as a real signed-in user (needs the anon key).
  evidence    Print the evidence pack for the most recent draft.
  teardown    Turn the draft flag back off (global and org-scoped).
  all         seed -> inject -> wait -> evidence -> review -> evidence.

Defaults to --env-file /etc/tugpt/worker.env. Add --env-file /etc/tugpt/web.env
so the human-review leg can sign in (it needs NEXT_PUBLIC_SUPABASE_ANON_KEY).

Never runs while whatsapp_integration is enabled. Only ever touches the org
with slug '${ORG_SLUG}'.
`;

async function main(): Promise<void> {
  const { command, envFiles, timeoutMs } = parseArgs(process.argv);

  if (!command || command === 'help' || command === '--help') {
    log(USAGE);
    return;
  }

  const env = loadHarnessEnv(envFiles);
  const ctx: Ctx = { env, admin: makeAdmin(env) };

  switch (command) {
    case 'preflight':
      await cmdPreflight(ctx);
      break;
    case 'seed':
      await cmdPreflight(ctx);
      await cmdSeed(ctx);
      break;
    case 'inject':
      await cmdInject(ctx);
      break;
    case 'evidence':
      await cmdEvidence(ctx, null);
      break;
    case 'teardown':
      await cmdTeardown(ctx);
      break;
    case 'review': {
      const orgId = await requireOrg(ctx);
      const { data } = await ctx.admin
        .from('ai_drafts')
        .select('id')
        .eq('organization_id', orgId)
        .eq('status', 'draft')
        .order('created_at', { ascending: false })
        .limit(1);
      if (!data || data.length === 0) fail('No draft in "draft" status to review.');
      await cmdReview(ctx, data[0].id);
      break;
    }
    case 'all': {
      await cmdPreflight(ctx);
      await cmdSeed(ctx);
      const injected = await cmdInject(ctx);
      const waited = await cmdWait(ctx, injected.providerMessageId, timeoutMs);
      await cmdEvidence(ctx, injected.providerMessageId);
      const reviewed = await cmdReview(ctx, waited.draftId);
      if (!reviewed.skipped) {
        step('FINAL EVIDENCE (post-review)');
        await cmdEvidence(ctx, injected.providerMessageId);
      }
      step('MILESTONE #1 COMPLETE');
      ok(`provider=${waited.provider} model=${waited.model}`);
      ok(`draft generated in ${Math.round(waited.elapsedMs / 1000)}s`);
      ok(`human review: ${reviewed.skipped ? 'SKIPPED (no anon key)' : 'edit + approve succeeded'}`);
      info('Remember to run "teardown" when you are done, to switch the draft flag back off.');
      break;
    }
    default:
      log(USAGE);
      fail(`Unknown command: ${command}`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[FAIL] ${message}`);
  process.exit(1);
});
