#!/usr/bin/env python3
"""
Phase 3B PostgREST HTTP Transport Test
File: scripts/database-tests/run_postgrest_tests.py

Tests that PostgREST preserves the custom SQLSTATE codes P3B01-P3B05
through real HTTP requests. PostgREST returns error codes in the JSON
response body under the "code" field.

For each test, reports:
  RPC name
  HTTP status returned by PostgREST
  SQLSTATE code received (from JSON body)
  Expected code
  Pass/fail
"""

import requests
import json
import time
import subprocess
import signal
import os
import sys
import uuid
import psycopg2

BASE_URL = "http://127.0.0.1:3000"
JWT_SECRET = "test-jwt-secret-for-phase3b-transport-tests-only"

passed = 0
failed = 0
failures = []

def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok {passed} - {name}")
    else:
        failed += 1
        print(f"  not ok {passed + failed} - {name} {detail}")
        failures.append(f"{name}: {detail}")

def get_db_conn():
    return psycopg2.connect(host='127.0.0.1', port=5432, database='tugpt_test', user='postgres', password='')

def setup_fixtures():
    """Create test fixtures for PostgREST transport tests."""
    conn = get_db_conn()
    org_id = str(uuid.uuid4())
    bp_id = str(uuid.uuid4())
    conn_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())

    with conn.cursor() as cur:
        # Clean up any previous test data
        cur.execute("DELETE FROM public.ai_draft_review_events WHERE organization_id = %s", (org_id,))
        cur.execute("UPDATE public.ai_drafts SET current_revision_id = NULL WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.ai_drafts WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.ai_draft_revisions WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_usage_reservations WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_usage_tracking WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_generation_jobs WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.failed_jobs WHERE queue_name = 'draft_generation'")
        cur.execute("DELETE FROM pgmq.q_draft_generation")
        cur.execute("DELETE FROM public.messages WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.conversations WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.inbound_message_staging WHERE webhook_event_id IN (SELECT id FROM public.webhook_events WHERE organization_id = %s)", (org_id,))
        cur.execute("DELETE FROM public.webhook_events WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.whatsapp_connections WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.business_profiles WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.feature_flags WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.audit_logs WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.organization_invitations WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.organization_members WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.organizations WHERE id = %s", (org_id,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user_id,))

        # Create org, user, business profile, whatsapp connection
        cur.execute("INSERT INTO public.organizations (id, name, slug) VALUES (%s, 'PostgREST Test Org', 'pgr-test-org')", (org_id,))
        cur.execute("""INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin)
                       VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', 'test@pgr.ai', '', '2026-01-01', '2026-01-01', '2026-01-01', '{}', '{}', false)""",
                    (user_id,))
        cur.execute("INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (%s, %s, 'owner')", (org_id, user_id))
        cur.execute("INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES (%s, %s, 'Test Business')", (bp_id, org_id))
        cur.execute("INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status) VALUES (%s, %s, %s, '+15551234567', 'conn-pgr-001', 'active')", (conn_id, org_id, bp_id))
        cur.execute("INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling) VALUES (%s, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 5)", (org_id,))

        # Ingest a message and create a draft
        cur.execute("""SELECT * FROM public.ingest_whatsapp_message_event(
            'conn-pgr-001', 'meta', 'wamid.pgr001', 'message',
            '0000000000000000000000000000000000000000000000000000000000000001',
            'wamid.pgr001', '15559876543', 'text', 'Hello from customer',
            '2026-01-01T00:00:00Z'::timestamptz, 'req-pgr001')""")
        cur.execute("SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr001'))")

        # Create a draft generation job, reserve, and store a draft
        draft_job_id = str(uuid.uuid4())
        cur.execute("""INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
                       SELECT %s, %s,
                         (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
                         (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr001')),
                         %s, 'queued'""",
                    (draft_job_id, org_id, org_id, bp_id))
        cur.execute("SELECT * FROM private.reserve_draft_usage(%s)", (draft_job_id,))
        cur.execute("""SELECT private.store_draft(%s, %s,
            (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
            (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr001')),
            'Test draft body', 'logicc', 'gpt-5-nano')""",
            (draft_job_id, bp_id, org_id))

        # Get the draft ID
        cur.execute("SELECT id FROM public.ai_drafts WHERE organization_id = %s", (org_id,))
        draft_id = cur.fetchone()[0]

        # Get the current version
        cur.execute("SELECT version FROM public.ai_drafts WHERE id = %s", (draft_id,))
        draft_version = cur.fetchone()[0]

    conn.commit()
    conn.close()

    return org_id, user_id, draft_id, draft_version

def make_jwt(user_id):
    """Create a simple JWT token for the authenticated role."""
    import base64
    import hmac
    import hashlib
    import time as _time

    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(_time.time()) + 3600,
        "iat": int(_time.time())
    }

    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()

    header_b64 = b64(header)
    payload_b64 = b64(payload)
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b'=').decode()

    return f"{header_b64}.{payload_b64}.{sig_b64}"

def call_rpc(rpc_name, params, jwt_token=None):
    """Call a PostgREST RPC and return (http_status, json_body)."""
    headers = {"Content-Type": "application/json"}
    if jwt_token:
        headers["Authorization"] = f"Bearer {jwt_token}"

    try:
        resp = requests.post(f"{BASE_URL}/rpc/{rpc_name}", json=params, headers=headers, timeout=10)
        return resp.status_code, resp.json() if resp.text else {}
    except requests.exceptions.ConnectionError:
        return None, {"error": "Connection refused - PostgREST not running"}
    except Exception as e:
        return None, {"error": str(e)}

def start_postgrest():
    """Start PostgREST in the background."""
    proc = subprocess.Popen(
        ["postgrest", "scripts/database-tests/postgrest.conf"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd="/workspace/tugpt-nextjs-recovered"
    )
    time.sleep(3)  # Wait for PostgREST to start
    return proc

def stop_postgrest(proc):
    """Stop PostgREST."""
    if proc:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)

def main():
    global passed, failed

    print("TAP version 13")
    print("1..10")

    # Start PostgREST
    print("# Starting PostgREST...")
    proc = start_postgrest()

    # Check if PostgREST is running
    try:
        resp = requests.get(f"{BASE_URL}/", timeout=5)
        print(f"# PostgREST is running (status {resp.status_code})")
    except:
        print("# PostgREST failed to start - cannot run transport tests")
        stop_postgrest(proc)
        sys.exit(1)

    # Setup fixtures
    print("# Setting up test fixtures...")
    org_id, user_id, draft_id, draft_version = setup_fixtures()
    jwt_token = make_jwt(user_id)

    # =============================================================================
    # P3B01: DRAFT_NOT_FOUND
    # Call approve_draft with a non-existent draft ID
    # =============================================================================
    print("# P3B01: DRAFT_NOT_FOUND")
    http_status, body = call_rpc("approve_draft", {
        "p_draft_id": str(uuid.uuid4()),  # non-existent
        "p_expected_lock_version": 1
    }, jwt_token)

    received_code = body.get("code", "") if isinstance(body, dict) else ""
    check("P3B01: HTTP status is 400", http_status == 400, f"got {http_status}")
    check("P3B01: SQLSTATE code is P3B01", received_code == "P3B01", f"got {received_code}")
    print(f"  RPC: approve_draft | HTTP: {http_status} | Code: {received_code} | Expected: P3B01 | {'PASS' if received_code == 'P3B01' else 'FAIL'}")

    # =============================================================================
    # P3B02: FORBIDDEN
    # Call approve_draft with a valid draft but wrong org (different user)
    # =============================================================================
    print("# P3B02: FORBIDDEN")
    # Create a JWT for a different user (not a member of the org)
    other_jwt = make_jwt(str(uuid.uuid4()))
    http_status, body = call_rpc("approve_draft", {
        "p_draft_id": draft_id,
        "p_expected_lock_version": draft_version
    }, other_jwt)

    received_code = body.get("code", "") if isinstance(body, dict) else ""
    check("P3B02: HTTP status is 400", http_status == 400, f"got {http_status}")
    check("P3B02: SQLSTATE code is P3B02", received_code == "P3B02", f"got {received_code}")
    print(f"  RPC: approve_draft | HTTP: {http_status} | Code: {received_code} | Expected: P3B02 | {'PASS' if received_code == 'P3B02' else 'FAIL'}")

    # =============================================================================
    # P3B03: STALE_VERSION
    # Call approve_draft with a wrong expected_lock_version
    # =============================================================================
    print("# P3B03: STALE_VERSION")
    http_status, body = call_rpc("approve_draft", {
        "p_draft_id": draft_id,
        "p_expected_lock_version": 999  # wrong version
    }, jwt_token)

    received_code = body.get("code", "") if isinstance(body, dict) else ""
    check("P3B03: HTTP status is 400", http_status == 400, f"got {http_status}")
    check("P3B03: SQLSTATE code is P3B03", received_code == "P3B03", f"got {received_code}")
    print(f"  RPC: approve_draft | HTTP: {http_status} | Code: {received_code} | Expected: P3B03 | {'PASS' if received_code == 'P3B03' else 'FAIL'}")

    # =============================================================================
    # P3B04: INVALID_STATE_TRANSITION
    # First approve the draft, then try to approve again (already approved)
    # =============================================================================
    print("# P3B04: INVALID_STATE_TRANSITION")
    # First: approve the draft successfully
    http_status, body = call_rpc("approve_draft", {
        "p_draft_id": draft_id,
        "p_expected_lock_version": draft_version
    }, jwt_token)
    print(f"# First approve: HTTP {http_status}")

    # Second: try to approve again (should fail with stale version since version incremented)
    http_status, body = call_rpc("approve_draft", {
        "p_draft_id": draft_id,
        "p_expected_lock_version": draft_version  # old version
    }, jwt_token)

    received_code = body.get("code", "") if isinstance(body, dict) else ""
    # After approval, the draft status is 'approved', not 'draft', so the UPDATE
    # in approve_draft will match 0 rows (status <> 'draft'), raising STALE_VERSION.
    # But the approved draft can't be approved again, which is an invalid state transition.
    # The function raises STALE_VERSION when the versioned UPDATE matches 0 rows.
    # This is the correct behavior: the caller's expected version is stale.
    check("P3B04: HTTP status is 400", http_status == 400, f"got {http_status}")
    # The code should be P3B03 (STALE_VERSION) since the version doesn't match
    # OR P3B04 if we had a specific check for invalid state transitions.
    # Since the function checks version first, it returns P3B03.
    # But Paul's requirement is P3B04 for INVALID_STATE_TRANSITION.
    # Let's check what we actually get and report it.
    check("P3B04: SQLSTATE code is P3B04", received_code == "P3B04", f"got {received_code}")
    print(f"  RPC: approve_draft | HTTP: {http_status} | Code: {received_code} | Expected: P3B04 | {'PASS' if received_code == 'P3B04' else 'FAIL (got P3B03 - stale version)'}")

    # =============================================================================
    # P3B05: INVALID_BODY
    # Call edit_draft with an empty body (NULL or empty string)
    # =============================================================================
    print("# P3B05: INVALID_BODY")
    # We need a draft in 'draft' status. Let's create a new one.
    conn = get_db_conn()
    with conn.cursor() as cur:
        # Create a new draft for this test
        cur.execute("""SELECT * FROM public.ingest_whatsapp_message_event(
            'conn-pgr-001', 'meta', 'wamid.pgr005', 'message',
            '0000000000000000000000000000000000000000000000000000000000000005',
            'wamid.pgr005', '15559876543', 'text', 'Hello 5',
            '2026-01-01T00:00:05Z'::timestamptz, 'req-pgr005')""")
        cur.execute("SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr005'))")

        draft_job_id2 = str(uuid.uuid4())
        cur.execute("""INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
                       SELECT %s, %s,
                         (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
                         (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr005')),
                         (SELECT id FROM public.business_profiles WHERE organization_id = %s), 'queued'""",
                    (draft_job_id2, org_id, org_id, org_id))
        cur.execute("SELECT * FROM private.reserve_draft_usage(%s)", (draft_job_id2,))
        cur.execute("""SELECT private.store_draft(%s, (SELECT id FROM public.business_profiles WHERE organization_id = %s),
            (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
            (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.pgr005')),
            'Test body 5', 'logicc', 'gpt-5-nano')""",
            (draft_job_id2, org_id, org_id))
        cur.execute("SELECT id, version FROM public.ai_drafts WHERE organization_id = %s AND id <> %s ORDER BY created_at DESC LIMIT 1", (org_id, draft_id))
        row = cur.fetchone()
        draft_id2 = row[0]
        draft_version2 = row[1]
    conn.commit()
    conn.close()

    # Call edit_draft with NULL body (should raise P3B05)
    http_status, body = call_rpc("edit_draft", {
        "p_draft_id": draft_id2,
        "p_expected_lock_version": draft_version2,
        "p_body": None  # NULL body
    }, jwt_token)

    received_code = body.get("code", "") if isinstance(body, dict) else ""
    check("P3B05: HTTP status is 400", http_status == 400, f"got {http_status}")
    check("P3B05: SQLSTATE code is P3B05", received_code == "P3B05", f"got {received_code}")
    print(f"  RPC: edit_draft | HTTP: {http_status} | Code: {received_code} | Expected: P3B05 | {'PASS' if received_code == 'P3B05' else 'FAIL'}")

    # Cleanup
    print("# Cleaning up...")
    conn = get_db_conn()
    with conn.cursor() as cur:
        cur.execute("UPDATE public.ai_drafts SET current_revision_id = NULL WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.ai_drafts WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.ai_draft_revisions WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.ai_draft_review_events WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_usage_reservations WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_usage_tracking WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_generation_jobs WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.failed_jobs WHERE queue_name = 'draft_generation'")
        cur.execute("DELETE FROM pgmq.q_draft_generation")
        cur.execute("DELETE FROM public.messages WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.conversations WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.inbound_message_staging WHERE webhook_event_id IN (SELECT id FROM public.webhook_events WHERE organization_id = %s)", (org_id,))
        cur.execute("DELETE FROM public.webhook_events WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.whatsapp_connections WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.business_profiles WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.feature_flags WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.audit_logs WHERE organization_id = %s", (org_id,))
        cur.execute("DELETE FROM public.organization_invitations WHERE organization_id = %s", (org_id,))
        # Temporarily disable the prevent_last_owner_removal trigger for cleanup
        cur.execute("ALTER TABLE public.organization_members DISABLE TRIGGER trigger_prevent_last_owner_removal")
        cur.execute("DELETE FROM public.organization_members WHERE organization_id = %s", (org_id,))
        cur.execute("ALTER TABLE public.organization_members ENABLE TRIGGER trigger_prevent_last_owner_removal")
        cur.execute("DELETE FROM public.organizations WHERE id = %s", (org_id,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user_id,))
    conn.commit()
    conn.close()

    # Stop PostgREST
    stop_postgrest(proc)

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed")
    if failures:
        print("Failures:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failed > 0 else 0)

if __name__ == '__main__':
    main()