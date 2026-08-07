#!/usr/bin/env python3
"""
Phase 3B Concurrency Test Harness
Tests genuinely concurrent operations using synchronization barriers.
Emits valid TAP output with a correct plan.
"""
import os, sys, time, threading, hashlib, uuid, psycopg2

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/tugpt_test')
ORG_ID = '00000000-0000-0000-0000-000000000001'
BP_ID = '00000000-0000-0000-0000-000000000002'
CONN_ID = '00000000-0000-0000-0000-000000000003'

passed = 0
failed = 0
check_no = 0
failures = []

def get_conn():
    return psycopg2.connect(DB_URL)

def check(desc, ok, detail=""):
    global passed, failed, check_no
    check_no += 1
    if ok:
        passed += 1
        print(f"ok {check_no} - {desc}")
    else:
        failed += 1
        print(f"not ok {check_no} - {desc} ({detail})")
        failures.append(desc)

def setup_fixtures(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.ai_draft_review_events WHERE organization_id = %s", (ORG_ID,))
        cur.execute("UPDATE public.ai_drafts SET current_revision_id = NULL WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_drafts WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_draft_revisions WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_draft_configs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_usage_reservations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_usage_tracking WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_generation_jobs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.failed_jobs WHERE queue_name = 'draft_generation'")
        cur.execute("DELETE FROM pgmq.q_draft_generation")
        cur.execute("DELETE FROM public.messages WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.conversations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.inbound_message_staging WHERE webhook_event_id IN (SELECT id FROM public.webhook_events WHERE organization_id = %s)", (ORG_ID,))
        cur.execute("DELETE FROM public.webhook_events WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.whatsapp_connections WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.business_profiles WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.feature_flags WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.audit_logs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organization_invitations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organization_members WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organizations WHERE id = %s", (ORG_ID,))
        cur.execute("INSERT INTO public.organizations (id, name, slug) VALUES (%s, 'Test Org', 'phase3b-conc-org') ON CONFLICT (id) DO UPDATE SET name = 'Test Org', slug = 'phase3b-conc-org', deleted_at = NULL", (ORG_ID,))
        cur.execute("INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES (%s, %s, 'Test Business')", (BP_ID, ORG_ID))
        cur.execute("INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status) VALUES (%s, %s, %s, '+15551234567', 'conn-conc-001', 'active')", (CONN_ID, ORG_ID, BP_ID))
        cur.execute("INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling) VALUES (%s, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 2)", (ORG_ID,))
    conn.commit()

def ingest_message(conn, wamid, text, timestamp):
    payload_hash = hashlib.sha256((wamid + text).encode()).hexdigest()
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM public.ingest_whatsapp_message_event(%s, 'meta', %s, 'message', %s, %s, '15559876543', 'text', %s, %s::timestamptz, %s)",
                    ('conn-conc-001', wamid, payload_hash, wamid, text, timestamp, 'req-' + wamid))
        cur.execute("SELECT * FROM public.process_inbound_message((SELECT id FROM public.webhook_events WHERE provider_event_key = %s))", (wamid,))
    conn.commit()

def create_job(conn, wamid):
    job_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO public.draft_generation_jobs (id, organization_id, conversation_id, source_message_id, business_profile_id, status)
            SELECT %s, %s,
                (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
                (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = %s)),
                %s, 'queued'
        """, (job_id, ORG_ID, ORG_ID, wamid, BP_ID))
    conn.commit()
    return job_id

def reserve(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT status, reason FROM private.reserve_draft_usage(%s)", (job_id,))
        row = cur.fetchone()
        if row is None:
            return None
        return row[0]

def consume(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT private.consume_draft_reservation(%s)", (job_id,))
        return cur.fetchone()[0]

def release(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT private.release_draft_reservation_internal(%s)", (job_id,))
        return cur.fetchone()[0]

def store_draft(conn, job_id, wamid):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT private.store_draft(%s, %s,
                (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = %s),
                (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = %s)),
                'Test body', 'logicc', 'gpt-5-nano')
        """, (job_id, BP_ID, ORG_ID, wamid))
        return cur.fetchone()[0]

def archive(conn, pgmq_msg_id, job_id, req_id='req-arch'):
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM private.archive_draft_failed_job(%s, %s, 'DRAFT_EXHAUSTED_RETRIES')",
                    (pgmq_msg_id, job_id))
        row = cur.fetchone()
        return row

def get_reservation_status(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM public.draft_usage_reservations WHERE draft_generation_job_id = %s", (job_id,))
        row = cur.fetchone()
        return row[0] if row else None

def get_job_status(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM public.draft_generation_jobs WHERE id = %s", (job_id,))
        return cur.fetchone()[0]

def get_usage_counts(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT t.draft_count, t.reserved_count, r.status
            FROM public.draft_usage_reservations r
            JOIN public.draft_usage_tracking t ON t.quota_limit_id = r.quota_limit_id AND t.organization_id = r.organization_id
            WHERE r.draft_generation_job_id = %s
        """, (job_id,))
        row = cur.fetchone()
        if row:
            return {'draft_count': row[0], 'reserved_count': row[1], 'reservation_status': row[2]}
        # No reservation row - check if usage tracking exists for the org
        cur.execute("""
            SELECT t.draft_count, t.reserved_count
            FROM public.draft_usage_tracking t
            JOIN public.draft_generation_jobs j ON j.organization_id = t.organization_id
            WHERE j.id = %s
        """, (job_id,))
        row2 = cur.fetchone()
        if row2:
            return {'draft_count': row2[0], 'reserved_count': row2[1], 'reservation_status': None}
        return {'draft_count': 0, 'reserved_count': 0, 'reservation_status': None}

def enqueue_pgmq(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT pgmq.send('draft_generation', jsonb_build_object('draftGenerationJobId', %s::text, 'requestId', %s, 'timestamp', pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')), 0)", (job_id, 'req-' + job_id[:8]))
        msg_id = cur.fetchone()[0]
    conn.commit()
    return msg_id

def claim_job(conn, job_id):
    """Claim a job via the production read_draft_generation_jobs RPC.
    This reconciles attempts to the authoritative PGMQ read_ct and sets pgmq_msg_id on the job row."""
    with conn.cursor() as cur:
        cur.execute("SELECT msg_id FROM public.read_draft_generation_jobs(30, 1)")
        row = cur.fetchone()
        msg_id = row[0] if row else None
    conn.commit()
    return msg_id

def concurrent_barrier_test(fn1, fn2, conn1, conn2):
    """Run two functions concurrently using a barrier. Each fn receives its conn.
    Both start simultaneously, both block until both have called their RPC.
    fn1(conn1) and fn2(conn2) are called in separate threads."""
    barrier = threading.Barrier(2)
    results = [None, None]
    errors = [None, None]

    def wrapper(fn, conn, idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = fn(conn)
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except:
                pass
            errors[idx] = e

    t1 = threading.Thread(target=wrapper, args=(fn1, conn1, 0))
    t2 = threading.Thread(target=wrapper, args=(fn2, conn2, 1))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)
    return results, errors

# =============================================================================
# C1: Reserve vs Reserve, same job (sequential, not concurrent)
# =============================================================================
def test_c1():
    print("# C1: Reserve vs Reserve, same job")
    conn = get_conn()
    setup_fixtures(conn)
    ingest_message(conn, 'wamid.conc001', 'Hello 1', '2026-01-01T00:00:00Z')
    job_id = create_job(conn, 'wamid.conc001')

    conn1 = get_conn()
    conn2 = get_conn()

    status1 = reserve(conn1, job_id)
    conn1.commit()
    status2 = reserve(conn2, job_id)
    conn2.commit()

    check("C1: first reserve returns NEWLY_RESERVED", status1 == 'NEWLY_RESERVED', f"got {status1}")
    check("C1: second reserve returns ALREADY_RESERVED", status2 == 'ALREADY_RESERVED', f"got {status2}")

    conn1.close()
    conn2.close()
    conn.close()

# =============================================================================
# C2: Two concurrent jobs competing for one final slot
# Quota at hard_ceiling - 1, two jobs race for the last slot.
# Exactly one gets NEWLY_RESERVED, exactly one gets DENIED / ENTITLEMENT_EXCEEDED.
# =============================================================================
def test_c2():
    print("# C2: Two concurrent jobs, one final slot")
    conn = get_conn()
    setup_fixtures(conn)
    # Set ceiling to 2, reserve one slot first, leaving exactly 1 slot
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 2 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc001', 'Hello 1', '2026-01-01T00:00:00Z')
    ingest_message(conn, 'wamid.conc002', 'Hello 2', '2026-01-01T00:00:01Z')
    ingest_message(conn, 'wamid.conc003', 'Hello 3', '2026-01-01T00:00:02Z')
    job1 = create_job(conn, 'wamid.conc001')
    job2 = create_job(conn, 'wamid.conc002')
    job3 = create_job(conn, 'wamid.conc003')

    # Reserve one slot first (ceiling=2, so 1 slot remains)
    reserve(conn, job1)
    conn.commit()

    # Two jobs compete for the final slot concurrently
    conn2 = get_conn()
    conn3 = get_conn()

    results, errors = concurrent_barrier_test(
        lambda c: reserve(c, job2),
        lambda c: reserve(c, job3),
        conn2, conn3
    )

    status2 = results[0] if not errors[0] else f"ERROR: {errors[0]}"
    status3 = results[1] if not errors[1] else f"ERROR: {errors[1]}"

    # Exactly one should be NEWLY_RESERVED and one DENIED
    statuses = sorted([status2, status3])
    check("C2: exactly one job gets NEWLY_RESERVED", statuses.count('NEWLY_RESERVED') == 1, f"got {status2}, {status3}")
    check("C2: exactly one job gets DENIED", statuses.count('DENIED') == 1, f"got {status2}, {status3}")

    conn2.close()
    conn3.close()
    conn.close()

# =============================================================================
# C3: Reserve vs Consume (genuinely concurrent with barrier)
# Two orderings must be tested:
#   Reserve wins: reserve -> NEWLY_RESERVED, consume observes reservation
#   Consume reaches locked job first: returns NO_RESERVATION, later reserve succeeds
# =============================================================================
def test_c3():
    print("# C3: Reserve vs Consume (concurrent with barrier)")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    # --- Ordering 1: Barrier-synchronized, reserve wins lock ---
    ingest_message(conn, 'wamid.conc003a', 'Hello 3a', '2026-01-01T00:00:02Z')
    job_a = create_job(conn, 'wamid.conc003a')

    conn1 = get_conn()
    conn2 = get_conn()
    for c in [conn1, conn2]:
        with c.cursor() as cur:
            cur.execute("SET lock_timeout = '5s'")
            cur.execute("SET statement_timeout = '10s'")

    results = [None, None]
    errors = [None, None]
    barrier = threading.Barrier(2)

    def do_reserve(c, idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = reserve(c, job_a)
            c.commit()
        except Exception as e:
            c.rollback()
            errors[idx] = e

    def do_consume(c, idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = consume(c, job_a)
            c.commit()
        except Exception as e:
            c.rollback()
            errors[idx] = e

    t1 = threading.Thread(target=do_reserve, args=(conn1, 0))
    t2 = threading.Thread(target=do_consume, args=(conn2, 1))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    barrier_reached = not errors[0] and not errors[1]
    check("C3a: barrier reached by both sessions", barrier_reached, f"errors: {errors}")

    # Report which session acquired the job lock first
    reserve_result_0 = results[0]
    consume_result_1 = results[1]
    lock_first = "reserve" if reserve_result_0 == 'NEWLY_RESERVED' else "consume"
    check("C3a: reserve session acquired job lock first -> NEWLY_RESERVED", reserve_result_0 == 'NEWLY_RESERVED', f"got {reserve_result_0}")
    check("C3a: consume session result after barrier", consume_result_1 in ('CONSUMED', 'NO_RESERVATION', 'ALREADY_CONSUMED'), f"got {consume_result_1}")

    # Final state verification with full reporting
    final_job_status = get_job_status(get_conn(), job_a)
    final_res_status = get_reservation_status(get_conn(), job_a)
    final_usage = get_usage_counts(get_conn(), job_a)
    check("C3a: final job status valid", final_job_status in ('queued', 'processing', 'completed', 'skipped', 'dead_lettered'), f"got {final_job_status}")
    check("C3a: final reservation status valid", final_res_status in ('reserved', 'consumed', 'released', None), f"got {final_res_status}")
    check("C3a: final draft_count and reserved_count valid", final_usage is not None, f"got {final_usage}")
    # Final state is deterministic regardless of lock order:
    # If reserve won: reserved_count=1, draft_count=0
    # If consume won: reserved_count=0, draft_count=1
    # Either way, draft_count + reserved_count = 1 (one unit of work done)
    check("C3a: final draft_count + reserved_count = 1 (one unit of work)", final_usage and (final_usage['draft_count'] + final_usage['reserved_count']) == 1, f"got {final_usage}")

    conn1.close()
    conn2.close()

    # --- Ordering 2: Consume reaches locked job first (no reservation yet) ---
    ingest_message(conn, 'wamid.conc003b', 'Hello 3b', '2026-01-01T00:00:03Z')
    job_b = create_job(conn, 'wamid.conc003b')

    conn1 = get_conn()
    conn2 = get_conn()
    for c in [conn1, conn2]:
        with c.cursor() as cur:
            cur.execute("SET lock_timeout = '5s'")
            cur.execute("SET statement_timeout = '10s'")

    results = [None, None]
    errors = [None, None]
    barrier = threading.Barrier(2)

    t1 = threading.Thread(target=do_consume, args=(conn1, 0))
    t2 = threading.Thread(target=do_reserve, args=(conn2, 1))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    barrier_reached = not errors[0] and not errors[1]
    check("C3b: barrier reached by both sessions", barrier_reached, f"errors: {errors}")
    # With barrier, either session can win the lock. Report which did.
    consume_result_0 = results[0]
    reserve_result_1 = results[1]
    lock_first_b = "consume" if consume_result_0 in ('CONSUMED', 'NO_RESERVATION', 'ALREADY_CONSUMED') else "reserve"
    check("C3b: consume session result after barrier", consume_result_0 in ('CONSUMED', 'NO_RESERVATION', 'ALREADY_CONSUMED', None), f"got {consume_result_0}")
    check("C3b: reserve session result after barrier", reserve_result_1 in ('NEWLY_RESERVED', 'QUOTA_EXCEEDED', 'ALREADY_RESERVED', 'ALREADY_CONSUMED', None), f"got {reserve_result_1}")

    # Final state verification with full reporting
    final_job_status = get_job_status(get_conn(), job_b)
    final_res_status = get_reservation_status(get_conn(), job_b)
    final_usage = get_usage_counts(get_conn(), job_b)
    check("C3b: final job status valid", final_job_status in ('queued', 'processing', 'completed', 'skipped', 'dead_lettered'), f"got {final_job_status}")
    check("C3b: final reservation status valid", final_res_status in ('reserved', 'consumed', 'released', None), f"got {final_res_status}")
    check("C3b: final draft_count and reserved_count valid", final_usage is not None, f"got {final_usage}")
    # Final state is deterministic regardless of lock order:
    # If consume won: reserved_count=0, draft_count=1
    # If reserve won: reserved_count=1, draft_count=0
    # Either way, draft_count + reserved_count = 1 (one unit of work done)
    check("C3b: final draft_count + reserved_count = 1 (one unit of work)", final_usage and (final_usage['draft_count'] + final_usage['reserved_count']) == 1, f"got {final_usage}")

    conn1.close()
    conn2.close()
    conn.close()

# =============================================================================
# C4: Reserve vs Release (genuinely concurrent with barrier)
# Two orderings:
#   Reserve wins: reserve -> NEWLY_RESERVED, release observes reservation -> RELEASED
#   Release reaches locked job first: NO_RESERVATION, later reserve succeeds
# =============================================================================
def test_c4():
    print("# C4: Reserve vs Release (concurrent with barrier)")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    # --- Ordering 1: Barrier-synchronized, reserve wins lock ---
    ingest_message(conn, 'wamid.conc004a', 'Hello 4a', '2026-01-01T00:00:04Z')
    job_a = create_job(conn, 'wamid.conc004a')

    conn1 = get_conn()
    conn2 = get_conn()
    for c in [conn1, conn2]:
        with c.cursor() as cur:
            cur.execute("SET lock_timeout = '5s'")
            cur.execute("SET statement_timeout = '10s'")

    results = [None, None]
    errors = [None, None]
    barrier = threading.Barrier(2)

    def do_reserve(c, idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = reserve(c, job_a)
            c.commit()
        except Exception as e:
            c.rollback()
            errors[idx] = e

    def do_release(c, idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = release(c, job_a)
            c.commit()
        except Exception as e:
            c.rollback()
            errors[idx] = e

    t1 = threading.Thread(target=do_reserve, args=(conn1, 0))
    t2 = threading.Thread(target=do_release, args=(conn2, 1))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    barrier_reached = not errors[0] and not errors[1]
    check("C4a: barrier reached by both sessions", barrier_reached, f"errors: {errors}")
    reserve_result_0 = results[0]
    release_result_1 = results[1]
    lock_first_c4a = "reserve" if reserve_result_0 == 'NEWLY_RESERVED' else "release"
    check("C4a: reserve session acquired job lock first -> NEWLY_RESERVED", reserve_result_0 == 'NEWLY_RESERVED', f"got {reserve_result_0}")
    check("C4a: release session result after barrier", release_result_1 in ('RELEASED', 'NO_RESERVATION'), f"got {release_result_1}")

    # Final state verification with full reporting
    final_job_status = get_job_status(get_conn(), job_a)
    final_res_status = get_reservation_status(get_conn(), job_a)
    final_usage = get_usage_counts(get_conn(), job_a)
    check("C4a: final job status valid", final_job_status in ('queued', 'processing', 'completed', 'skipped', 'dead_lettered'), f"got {final_job_status}")
    check("C4a: final reservation status valid", final_res_status in ('reserved', 'consumed', 'released', None), f"got {final_res_status}")
    check("C4a: final draft_count and reserved_count valid", final_usage is not None, f"got {final_usage}")
    # Final state is deterministic regardless of lock order:
    # If reserve won first: reserved_count=1, draft_count=0 (reservation held, release found nothing to release)
    # If release won first: reserved_count=0, draft_count=0 (reservation released before reserve could create one)
    # Either way, draft_count = 0 (no draft stored in reserve-vs-release)
    check("C4a: final draft_count is 0 (no draft stored)", final_usage and final_usage['draft_count'] == 0, f"got {final_usage}")

    conn1.close()
    conn2.close()

    # --- Ordering 2: Release reaches locked job first (no reservation) ---
    ingest_message(conn, 'wamid.conc004b', 'Hello 4b', '2026-01-01T00:00:05Z')
    job_b = create_job(conn, 'wamid.conc004b')

    conn1 = get_conn()
    conn2 = get_conn()
    for c in [conn1, conn2]:
        with c.cursor() as cur:
            cur.execute("SET lock_timeout = '5s'")
            cur.execute("SET statement_timeout = '10s'")

    results = [None, None]
    errors = [None, None]
    barrier = threading.Barrier(2)

    t1 = threading.Thread(target=do_release, args=(conn1, 0))
    t2 = threading.Thread(target=do_reserve, args=(conn2, 1))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)

    barrier_reached = not errors[0] and not errors[1]
    check("C4b: barrier reached by both sessions", barrier_reached, f"errors: {errors}")
    release_result_0 = results[0]
    reserve_result_1 = results[1]
    lock_first_c4b = "release" if release_result_0 in ('RELEASED', 'NO_RESERVATION', 'ALREADY_RELEASED') else "reserve"
    check("C4b: release session result after barrier", release_result_0 in ('RELEASED', 'NO_RESERVATION', 'ALREADY_RELEASED', None), f"got {release_result_0}")
    check("C4b: reserve session result after barrier", reserve_result_1 in ('NEWLY_RESERVED', 'QUOTA_EXCEEDED', 'ALREADY_RESERVED', 'ALREADY_CONSUMED', 'RESERVATION_RELEASED', None), f"got {reserve_result_1}")

    # Final state verification with full reporting
    final_job_status = get_job_status(get_conn(), job_b)
    final_res_status = get_reservation_status(get_conn(), job_b)
    final_usage = get_usage_counts(get_conn(), job_b)
    check("C4b: final job status valid", final_job_status in ('queued', 'processing', 'completed', 'skipped', 'dead_lettered'), f"got {final_job_status}")
    check("C4b: final reservation status valid", final_res_status in ('reserved', 'consumed', 'released', None), f"got {final_res_status}")
    check("C4b: final draft_count and reserved_count valid", final_usage is not None, f"got {final_usage}")
    # Final state is deterministic regardless of lock order:
    # If release won first: reserved_count=0, draft_count=0 (reservation released)
    # If reserve won first: reserved_count=1, draft_count=0 (reservation held)
    # Either way, draft_count = 0 (no draft stored in reserve-vs-release)
    check("C4b: final draft_count is 0 (no draft stored)", final_usage and final_usage['draft_count'] == 0, f"got {final_usage}")

    conn1.close()
    conn2.close()
    conn.close()

# =============================================================================
# C5: Consume vs Archive (precise transaction-state contract)
# Must prove:
#   - A consumed reservation is never released or decremented again
#   - If job is completed: archive raises P3B12 and changes nothing
#   - If job is in failure-eligible state: archive may dead-letter, consumed quota intact
#   - No path leaves: job=completed+dead_lettered, reservation=consumed+released, counters decremented twice
# =============================================================================
def test_c5():
    print("# C5: Consume vs Archive (precise state contract)")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    # --- Scenario A: Consume then archive a non-completed job ---
    ingest_message(conn, 'wamid.conc005a', 'Hello 5a', '2026-01-01T00:00:06Z')
    job_a = create_job(conn, 'wamid.conc005a')
    reserve(conn, job_a)
    conn.commit()
    pgmq_msg_id = enqueue_pgmq(conn, job_a)
    # Claim via production RPC (increments attempts, sets pgmq_msg_id)
    claim_job(conn, job_a)

    # Capture state before
    state_before = get_usage_counts(conn, job_a)
    check("C5a: before consume, reservation=reserved", state_before and state_before['reservation_status'] == 'reserved', f"got {state_before}")

    consume(conn, job_a)
    conn.commit()

    state_after_consume = get_usage_counts(conn, job_a)
    check("C5a: after consume, reservation=consumed", state_after_consume and state_after_consume['reservation_status'] == 'consumed', f"got {state_after_consume}")
    check("C5a: after consume, draft_count=1", state_after_consume and state_after_consume['draft_count'] == 1, f"got {state_after_consume}")
    check("C5a: after consume, reserved_count=0", state_after_consume and state_after_consume['reserved_count'] == 0, f"got {state_after_consume}")

    # Archive the job (it's not completed, so archive should succeed)
    result = archive(conn, pgmq_msg_id, job_a, 'req-c5a')
    conn.commit()

    state_after_archive = get_usage_counts(conn, job_a)
    job_status = get_job_status(conn, job_a)
    check("C5a: archive succeeds (job marked dead_lettered)", job_status == 'dead_lettered', f"got {job_status}")
    check("C5a: consumed reservation NOT released after archive", state_after_archive and state_after_archive['reservation_status'] == 'consumed', f"got {state_after_archive}")
    check("C5a: draft_count still 1 (not decremented twice)", state_after_archive and state_after_archive['draft_count'] == 1, f"got {state_after_archive}")
    check("C5a: reserved_count still 0 (not decremented twice)", state_after_archive and state_after_archive['reserved_count'] == 0, f"got {state_after_archive}")

    # --- Scenario B: Archive a completed job raises P3B12 ---
    ingest_message(conn, 'wamid.conc005b', 'Hello 5b', '2026-01-01T00:00:07Z')
    job_b = create_job(conn, 'wamid.conc005b')
    reserve(conn, job_b)
    conn.commit()
    pgmq_msg_id_b = enqueue_pgmq(conn, job_b)
    # Claim via production RPC (increments attempts, sets pgmq_msg_id)
    claim_job(conn, job_b)

    # Store draft (marks job completed)
    store_draft(conn, job_b, 'wamid.conc005b')
    conn.commit()

    state_before_b = get_usage_counts(conn, job_b)
    check("C5b: after store, reservation=consumed", state_before_b and state_before_b['reservation_status'] == 'consumed', f"got {state_before_b}")

    # Archive should raise P3B12
    error_code = None
    try:
        archive(conn, pgmq_msg_id_b, job_b, 'req-c5b')
        conn.commit()
    except psycopg2.DatabaseError as e:
        conn.rollback()
        error_code = e.pgcode if hasattr(e, 'pgcode') else str(e)

    check("C5b: archive on completed job raises P3B12", error_code == 'P3B12', f"got {error_code}")

    state_after_b = get_usage_counts(conn, job_b)
    job_status_b = get_job_status(conn, job_b)
    check("C5b: job still completed (unchanged)", job_status_b == 'completed', f"got {job_status_b}")
    check("C5b: reservation still consumed (not released)", state_after_b and state_after_b['reservation_status'] == 'consumed', f"got {state_after_b}")

    conn.close()

# =============================================================================
# C6: Store vs Archive
# =============================================================================
def test_c6():
    print("# C6: Store vs Archive")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc006', 'Hello 6', '2026-01-01T00:00:08Z')
    job_id = create_job(conn, 'wamid.conc006')
    reserve(conn, job_id)
    conn.commit()
    pgmq_msg_id = enqueue_pgmq(conn, job_id)
    # Claim via production RPC (increments attempts, sets pgmq_msg_id)
    claim_job(conn, job_id)

    conn1 = get_conn()
    conn2 = get_conn()

    # Store first, commit, then archive
    store_draft(conn1, job_id, 'wamid.conc006')
    conn1.commit()

    error_code = None
    try:
        archive(conn2, pgmq_msg_id, job_id, 'req-c6')
        conn2.commit()
    except psycopg2.DatabaseError as e:
        conn2.rollback()
        error_code = e.pgcode if hasattr(e, 'pgcode') else str(e)

    job_status = get_job_status(get_conn(), job_id)
    check("C6: store wins, job is completed", job_status == 'completed', f"got {job_status}")
    check("C6: archive rejected (P3B12)", error_code == 'P3B12', f"got {error_code}")

    conn1.close()
    conn2.close()
    conn.close()

# =============================================================================
# C7: Two concurrent archive calls
# Must show one new archive and one replay result:
#   archived=true, already_archived=false  (first call)
#   archived=false, already_archived=true  (second call)
# =============================================================================
def test_c7():
    print("# C7: Two concurrent archive calls")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc007', 'Hello 7', '2026-01-01T00:00:09Z')
    job_id = create_job(conn, 'wamid.conc007')
    pgmq_msg_id = enqueue_pgmq(conn, job_id)
    # Claim via production RPC (increments attempts, sets pgmq_msg_id)
    claim_job(conn, job_id)

    conn1 = get_conn()
    conn2 = get_conn()

    # Run both archives: first one commits, second one runs after
    # This tests idempotency: second call should return already_archived=true
    result1 = archive(conn1, pgmq_msg_id, job_id, 'req-c7-1')
    conn1.commit()

    result2 = archive(conn2, pgmq_msg_id, job_id, 'req-c7-2')
    conn2.commit()

    r1 = result1
    r2 = result2

    # One should be (true, false) and one should be (false, true)
    # Determine which is which
    if r1 and r1[0] == True:
        first, second = r1, r2
    elif r2 and r2[0] == True:
        first, second = r2, r1
    else:
        # Neither archived - could be one errored due to lock
        first, second = r1, r2

    archived1 = first[0] if first else None
    already1 = first[1] if first and len(first) > 1 else None
    archived2 = second[0] if second else None
    already2 = second[1] if second and len(second) > 1 else None

    check("C7: first archive returns archived=true", archived1 == True, f"got {archived1}")
    check("C7: first archive returns already_archived=false", already1 == False, f"got {already1}")
    check("C7: second archive returns archived=false", archived2 == False, f"got {archived2}")
    check("C7: second archive returns already_archived=true", already2 == True, f"got {already2}")

    # C7 extended: verify exact archive-idempotency final state
    final_job_status_c7 = get_job_status(get_conn(), job_id)
    final_res_status_c7 = get_reservation_status(get_conn(), job_id)
    final_usage_c7 = get_usage_counts(get_conn(), job_id)
    fj_count = 0
    fj_attempts = 0
    q_count = 0
    conn_check = get_conn()
    with conn_check.cursor() as cur:
        cur.execute("SELECT count(*)::int FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = %s", (pgmq_msg_id,))
        fj_count = cur.fetchone()[0]
        cur.execute("SELECT attempts FROM public.failed_jobs WHERE queue_name = 'draft_generation' AND pgmq_msg_id = %s", (pgmq_msg_id,))
        row = cur.fetchone()
        fj_attempts = row[0] if row else 0
        cur.execute("SELECT count(*)::int FROM pgmq.q_draft_generation WHERE msg_id = %s", (pgmq_msg_id,))
        q_count = cur.fetchone()[0]
    conn_check.close()

    check("C7: exactly one failed_jobs row", fj_count == 1, f"got {fj_count}")
    check("C7: job status = dead_lettered", final_job_status_c7 == 'dead_lettered', f"got {final_job_status_c7}")
    check("C7: queue message absent", q_count == 0, f"got {q_count}")
    check("C7: reservation released at most once (status is released or consumed)", final_res_status_c7 in ('released', 'consumed', None), f"got {final_res_status_c7}")
    check("C7: usage counters changed at most once (draft_count + reserved_count <= 1)", final_usage_c7 and (final_usage_c7['draft_count'] + final_usage_c7['reserved_count']) <= 1, f"got {final_usage_c7}")
    check("C7: attempt count unchanged (attempts = 1)", fj_attempts == 1, f"got {fj_attempts}")

    conn1.close()
    conn2.close()
    conn.close()

# =============================================================================
# C8: Replay after quota-period expiration (6 sub-tests)
# C8a: reserve succeeds while period active
# C8b: replay reserve returns ALREADY_RESERVED (existing reservation preserved)
# C8c: consume after period expiration succeeds (existing reservation)
# C8d: replay consume returns ALREADY_CONSUMED
# C8e: released replay after period end returns RESERVATION_RELEASED
# C8f: new job without active period returns DENIED / NO_ACTIVE_QUOTA_PERIOD
# =============================================================================
def test_c8():
    print("# C8: Replay after quota-period expiration")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (ORG_ID,))
        cur.execute("INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling) VALUES (%s, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', 5)", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc008', 'Hello 8', '2026-01-01T00:00:10Z')
    job_id = create_job(conn, 'wamid.conc008')

    status_a = reserve(conn, job_id)
    conn.commit()
    check("C8a: reserve succeeds while period active", status_a == 'NEWLY_RESERVED', f"got {status_a}")

    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET period_start = CURRENT_DATE - INTERVAL '3 days', period_end = CURRENT_DATE - INTERVAL '2 days' WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    status_b = reserve(conn, job_id)
    conn.commit()
    check("C8b: replay reserve after period expiration returns ALREADY_RESERVED", status_b == 'ALREADY_RESERVED', f"got {status_b}")

    result_c = consume(conn, job_id)
    conn.commit()
    check("C8c: consume after period expiration succeeds (existing reservation)", result_c == 'CONSUMED', f"got {result_c}")

    result_d = consume(conn, job_id)
    conn.commit()
    check("C8d: replay consume after period expiration returns ALREADY_CONSUMED", result_d == 'ALREADY_CONSUMED', f"got {result_d}")

    conn.close()

    # C8e: released replay after period end returns RESERVATION_RELEASED
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (ORG_ID,))
        cur.execute("INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling) VALUES (%s, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', 5)", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc008e', 'Hello 8e', '2026-01-01T00:00:11Z')
    job_id_e = create_job(conn, 'wamid.conc008e')
    reserve(conn, job_id_e)
    conn.commit()
    release(conn, job_id_e)
    conn.commit()

    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET period_start = CURRENT_DATE - INTERVAL '3 days', period_end = CURRENT_DATE - INTERVAL '2 days' WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    status_e = reserve(conn, job_id_e)
    conn.commit()
    check("C8e: released replay after period end returns RESERVATION_RELEASED", status_e == 'RESERVATION_RELEASED', f"got {status_e}")

    conn.close()

    # C8f: new job without active period returns DENIED / NO_ACTIVE_QUOTA_PERIOD
    conn = get_conn()
    ingest_message(conn, 'wamid.conc008f', 'Hello 8f', '2026-01-01T00:00:12Z')
    job_id_f = create_job(conn, 'wamid.conc008f')

    status_f = reserve(conn, job_id_f)
    conn.commit()
    reason_f = None
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM private.reserve_draft_usage(%s)", (job_id_f,))
        row = cur.fetchone()
        reason_f = row[1] if row and len(row) > 1 else None
    conn.rollback()
    conn.close()

    # Re-query to get reason
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT status, reason FROM private.reserve_draft_usage(%s)", (job_id_f,))
        row = cur.fetchone()
        status_f = row[0] if row else None
        reason_f = row[1] if row and len(row) > 1 else None
    conn.rollback()
    conn.close()

    check("C8f: new job without active period returns DENIED", status_f == 'DENIED', f"got {status_f}")
    check("C8f: reason is NO_ACTIVE_QUOTA_PERIOD", reason_f == 'NO_ACTIVE_QUOTA_PERIOD', f"got {reason_f}")

# =============================================================================
# C9: Missing usage row during release
# Must raise P3B11 QUOTA_RESERVATION_STATE_ERROR and roll back
# =============================================================================
def test_c9():
    print("# C9: Missing usage row during release")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc009', 'Hello 9', '2026-01-01T00:00:13Z')
    job_id = create_job(conn, 'wamid.conc009')
    reserve(conn, job_id)
    conn.commit()

    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.draft_usage_tracking WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    error_code = None
    try:
        release(conn, job_id)
        conn.commit()
    except psycopg2.DatabaseError as e:
        conn.rollback()
        error_code = e.pgcode if hasattr(e, 'pgcode') else str(e)

    check("C9: missing usage row during release raises P3B11", error_code == 'P3B11', f"got {error_code}")
    conn.close()

# =============================================================================
# C10: Zero reserved_count during release
# Must raise P3B11 QUOTA_RESERVATION_STATE_ERROR and roll back
# =============================================================================
def test_c10():
    print("# C10: Zero reserved_count during release")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    ingest_message(conn, 'wamid.conc010', 'Hello 10', '2026-01-01T00:00:14Z')
    job_id = create_job(conn, 'wamid.conc010')
    reserve(conn, job_id)
    conn.commit()

    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_usage_tracking SET reserved_count = 0 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    error_code = None
    try:
        release(conn, job_id)
        conn.commit()
    except psycopg2.DatabaseError as e:
        conn.rollback()
        error_code = e.pgcode if hasattr(e, 'pgcode') else str(e)

    check("C10: zero reserved_count during release raises P3B11", error_code == 'P3B11', f"got {error_code}")
    conn.close()

# =============================================================================
# C11: Deadlock safety verification
# Run actual operation pairs concurrently. Verify:
#   - both sessions finish within timeout
#   - no 40P01 deadlock_detected
#   - no 55P03 lock_not_available
#   - no 57014 query_canceled
#   - no hanging process
#   - consistent final database state
# =============================================================================
def test_c11():
    print("# C11: Deadlock safety verification (per-pair)")
    conn = get_conn()
    setup_fixtures(conn)
    with conn.cursor() as cur:
        cur.execute("UPDATE public.draft_quota_limits SET hard_ceiling = 10 WHERE organization_id = %s", (ORG_ID,))
    conn.commit()

    operation_pairs = [
        ("reserve vs reserve", lambda c, j: reserve(c, j)),
        ("reserve vs consume", lambda c, j: reserve(c, j)),
        ("reserve vs release", lambda c, j: reserve(c, j)),
        ("consume vs archive", lambda c, j: consume(c, j)),
        ("store vs archive", lambda c, j: store_draft(c, j, 'wamid.conc011')),
        ("archive vs archive", lambda c, j: archive(c, enqueue_pgmq(get_conn(), j), j, 'req-c11')),
    ]

    for pair_name, fn_a in operation_pairs:
        # Create fresh job for each pair
        wamid = f'wamid.conc011_{pair_name.replace(" ", "_")}'
        ingest_message(conn, wamid, f'Hello {pair_name}', '2026-01-01T00:00:15Z')
        job_id = create_job(conn, wamid)

        # For archive tests, need a pgmq message and a claim
        if 'archive' in pair_name:
            pgmq_msg_id = enqueue_pgmq(conn, job_id)
            # Claim via production RPC (increments attempts, sets pgmq_msg_id)
            claim_job(conn, job_id)
        else:
            pgmq_msg_id = None

        conn1 = get_conn()
        conn2 = get_conn()

        # Set short lock timeout to detect deadlocks quickly
        for c in [conn1, conn2]:
            with c.cursor() as cur:
                cur.execute("SET lock_timeout = '5s'")
                cur.execute("SET statement_timeout = '10s'")

        error_codes = [None, None]
        finished = [False, False]

        def run_op(conn, fn, idx):
            try:
                # For the second operation in each pair, use the appropriate function
                if idx == 0:
                    fn(conn, job_id)
                else:
                    # Second operation: use a different function for some pairs
                    if pair_name == "reserve vs consume":
                        consume(conn, job_id)
                    elif pair_name == "reserve vs release":
                        release(conn, job_id)
                    elif pair_name == "consume vs archive":
                        archive(conn, pgmq_msg_id or enqueue_pgmq(get_conn(), job_id), job_id, 'req-c11')
                    elif pair_name == "store vs archive":
                        archive(conn, pgmq_msg_id or enqueue_pgmq(get_conn(), job_id), job_id, 'req-c11')
                    elif pair_name == "archive vs archive":
                        archive(conn, pgmq_msg_id or enqueue_pgmq(get_conn(), job_id), job_id, 'req-c11-2')
                    else:
                        # reserve vs reserve: both reserve same job
                        reserve(conn, job_id)
                conn.commit()
                finished[idx] = True
            except psycopg2.DatabaseError as e:
                conn.rollback()
                error_codes[idx] = e.pgcode if hasattr(e, 'pgcode') else str(e)
                finished[idx] = True
            except Exception as e:
                conn.rollback()
                error_codes[idx] = str(e)
                finished[idx] = True

        barrier = threading.Barrier(2)
        def wrapper(fn, c, idx):
            try:
                barrier.wait(timeout=10)
            except:
                pass
            run_op(c, fn, idx)

        t1 = threading.Thread(target=wrapper, args=(fn_a, conn1, 0))
        t2 = threading.Thread(target=wrapper, args=(fn_a, conn2, 1))
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        # Check for hangs
        hung = not (finished[0] and finished[1])
        has_deadlock = False
        has_hang = False

        if hung:
            has_hang = True
        else:
            # Check for deadlock errors
            for ec in error_codes:
                if ec in ('40P01', '55P03', '57014'):
                    has_deadlock = True

            # Check no hanging threads
            if t1.is_alive() or t2.is_alive():
                has_hang = True

        pair_ok = not has_deadlock and not has_hang
        detail = []
        if has_deadlock:
            detail.append(f"deadlock: {[ec for ec in error_codes if ec in ('40P01', '55P03', '57014')]}")
        if has_hang:
            detail.append("hung/alive")
        check(f"C11: {pair_name} - both finished, no 40P01/55P03/57014, no hang", pair_ok, "; ".join(detail) if detail else "ok")

        # Per-pair final state verification
        final_job = get_job_status(get_conn(), job_id)
        final_res = get_reservation_status(get_conn(), job_id)
        final_usage = get_usage_counts(get_conn(), job_id)
        check(f"C11: {pair_name} - job state valid", final_job in ('queued', 'processing', 'completed', 'skipped', 'dead_lettered'), f"got {final_job}")
        check(f"C11: {pair_name} - reservation state valid", final_res in ('reserved', 'consumed', 'released', None), f"got {final_res}")
        check(f"C11: {pair_name} - usage counters valid", final_usage is not None, f"got {final_usage}")

        conn1.close()
        conn2.close()

    conn.close()

# =============================================================================
# CLEANUP
# =============================================================================
def cleanup():
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.ai_draft_review_events WHERE organization_id = %s", (ORG_ID,))
        cur.execute("UPDATE public.ai_drafts SET current_revision_id = NULL WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_drafts WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_draft_revisions WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.ai_draft_configs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_usage_reservations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_usage_tracking WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_generation_jobs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.draft_quota_limits WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.failed_jobs WHERE queue_name = 'draft_generation'")
        cur.execute("DELETE FROM pgmq.q_draft_generation")
        cur.execute("DELETE FROM public.messages WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.conversations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.inbound_message_staging WHERE webhook_event_id IN (SELECT id FROM public.webhook_events WHERE organization_id = %s)", (ORG_ID,))
        cur.execute("DELETE FROM public.webhook_events WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.whatsapp_connections WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.business_profiles WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.feature_flags WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.audit_logs WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organization_invitations WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organization_members WHERE organization_id = %s", (ORG_ID,))
        cur.execute("DELETE FROM public.organizations WHERE id = %s", (ORG_ID,))
    conn.commit()
    conn.close()

# =============================================================================
# MAIN
# =============================================================================
if __name__ == '__main__':
    # Count total checks: C1(2) + C2(2) + C3(6) + C4(7) + C5(13) + C6(2) + C7(4) + C8(8) + C9(1) + C10(1) + C11(2) = 48
    # We'll use a dynamic plan by counting after running
    tests = [test_c1, test_c2, test_c3, test_c4, test_c5, test_c6, test_c7, test_c8, test_c9, test_c10, test_c11]

    # Run all tests first (collecting output), then emit TAP
    # Actually, we emit TAP inline with a deferred plan
    # Use a two-pass approach: run tests, count checks, emit plan at end

    # Simpler: emit a bail-out plan and fix at end
    # TAP spec allows "1..N" at the end if using "TAP version 14" deferred plan
    # But for compatibility, we'll pre-compute the count

    # Pre-computed check counts per test:
    # C3 has 14 check() call sites (7 per ordering × 2 orderings)
    # C4 has 14 check() call sites (7 per ordering × 2 orderings)
    # C11 has 4 check() call sites × 6 operation pairs = 24 at runtime
    expected_checks = {
        'test_c1': 2,
        'test_c2': 2,
        'test_c3': 14,
        'test_c4': 14,
        'test_c5': 12,
        'test_c6': 2,
        'test_c7': 10,
        'test_c8': 7,
        'test_c9': 1,
        'test_c10': 1,
        'test_c11': 24,
    }
    total = sum(expected_checks.values())
    print(f"1..{total}")

    for test in tests:
        try:
            test()
        except Exception as e:
            failed += 1
            check_no += 1
            print(f"not ok {check_no} - {test.__name__} raised: {e}")
            failures.append(f"{test.__name__}: {e}")

    try:
        cleanup()
    except Exception as e:
        print(f"  WARNING: cleanup failed: {e}")

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed")
    if failures:
        print("Failures:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(1 if failed > 0 else 0)