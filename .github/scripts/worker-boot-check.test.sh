#!/bin/sh
#
# Fixtures for worker-boot-check.sh.
#
# The boot check exists because CI built an image it never started. A boot
# check that is itself never exercised is the same mistake one level up, so
# this drives it against a stubbed `docker` and asserts what it reports.
#
#   sh .github/scripts/worker-boot-check.test.sh
#
# The stub is a `docker` earlier on PATH. It serves scripted logs and state
# per container, so the cases below can reproduce the real failures — a worker
# that never prints its start line (the 2026-08-25 crash-loop), and one that
# prints it and then dies, which a naive log-grep would call a pass.
set -u

SCRIPT_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
UNDER_TEST="$SCRIPT_DIR/worker-boot-check.sh"

pass_count=0
fail_count=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Build a stub `docker` in $1/bin that reads its scripted answers from $1/state.
make_stub() {
  _dir="$1"
  mkdir -p "$_dir/bin" "$_dir/state"
  cat > "$_dir/bin/docker" <<'STUB'
#!/bin/sh
# Stub docker. State lives in $STUB_STATE:
#   counter          how many `run` calls have happened
#   <n>.log          what `logs` prints for container n
#   <n>.running      "true" / "false"
#   <n>.exit         exit code string
#   <n>.runfail      if present, `run` fails
set -u
STATE="$STUB_STATE"

case "$1" in
  run)
    n=$(cat "$STATE/counter" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$STATE/counter"
    if [ -f "$STATE/$n.runfail" ]; then
      echo "stub: run refused" >&2
      exit 125
    fi
    echo "container$n"
    ;;
  logs)
    shift
    cid=$1
    n=${cid#container}
    cat "$STATE/$n.log" 2>/dev/null || true
    ;;
  inspect)
    # inspect -f '<template>' <cid>
    fmt=$3
    cid=$4
    n=${cid#container}
    case "$fmt" in
      *State.Running*)  cat "$STATE/$n.running" 2>/dev/null || echo false ;;
      *State.ExitCode*) cat "$STATE/$n.exit"    2>/dev/null || echo 0 ;;
      *) echo '' ;;
    esac
    ;;
  rm) : ;;
  *) : ;;
esac
STUB
  chmod +x "$_dir/bin/docker"
}

# run_case <name> <dir>  -> stdout in $OUT, exit status in $STATUS
run_case() {
  _name="$1"
  _dir="$2"
  OUT=$(PATH="$_dir/bin:$PATH" STUB_STATE="$_dir/state" \
        BOOT_TIMEOUT_SECONDS="${CASE_TIMEOUT:-3}" \
        sh "$UNDER_TEST" tugpt-worker:test 2>&1)
  STATUS=$?
  printf '%s\n' "--- $_name (exit $STATUS) ---"
}

assert_status() {
  if [ "$STATUS" -eq "$1" ]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
    printf 'FAIL  expected exit %s, got %s\n' "$1" "$STATUS"
    printf '%s\n' "$OUT"
  fi
}

assert_contains() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
    printf 'FAIL  output did not contain: %s\n' "$1"
    printf '%s\n' "$OUT"
  fi
}

assert_not_contains() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then
    fail_count=$((fail_count + 1))
    printf 'FAIL  output should not contain: %s\n' "$1"
    printf '%s\n' "$OUT"
  else
    pass_count=$((pass_count + 1))
  fi
}

WHATSAPP_LINE='Worker started. Polling whatsapp_inbound queue...'
DRAFT_LINE='{"timestamp":"x","level":"info","message":"Draft worker started"}'

# ---------------------------------------------------------------- case 1
# Both workers boot and stay up. The only shape that may exit 0.
C="$WORK/c1"; make_stub "$C"
printf '%s\n' "$WHATSAPP_LINE" > "$C/state/1.log"; echo true > "$C/state/1.running"
printf '%s\n' "$DRAFT_LINE"    > "$C/state/2.log"; echo true > "$C/state/2.running"
run_case 'both boot' "$C"
assert_status 0
assert_contains 'ok    whatsapp-worker'
assert_contains 'ok    draft-worker'
assert_contains 'Both workers booted.'

# ---------------------------------------------------------------- case 2
# The 2026-08-25 crash-loop: ERR_MODULE_NOT_FOUND, no start line, exited.
C="$WORK/c2"; make_stub "$C"
cat > "$C/state/1.log" <<'LOG'
node:internal/modules/esm/resolve:1001
    throw error;
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/packages/database/src/client'
imported from /app/packages/database/src/index.ts
LOG
echo false > "$C/state/1.running"; echo 1 > "$C/state/1.exit"
printf '%s\n' "$DRAFT_LINE" > "$C/state/2.log"; echo true > "$C/state/2.running"
run_case 'whatsapp crash-loops' "$C"
assert_status 1
assert_contains 'FAIL  whatsapp-worker'
assert_contains 'never printed'
assert_contains 'ERR_MODULE_NOT_FOUND'
assert_contains '1 worker(s) failed to boot.'
# The draft worker still ran: one failure must not short-circuit the other.
assert_contains 'ok    draft-worker'

# ---------------------------------------------------------------- case 3
# Prints the start line, then dies. A log-grep alone would call this a pass.
C="$WORK/c3"; make_stub "$C"
printf '%s\n' "$WHATSAPP_LINE" > "$C/state/1.log"
echo false > "$C/state/1.running"; echo 137 > "$C/state/1.exit"
printf '%s\n' "$DRAFT_LINE" > "$C/state/2.log"; echo true > "$C/state/2.running"
run_case 'starts then exits' "$C"
assert_status 1
assert_contains 'printed its start line and then exited (code 137)'

# ---------------------------------------------------------------- case 4
# docker run itself fails.
C="$WORK/c4"; make_stub "$C"
touch "$C/state/1.runfail"
printf '%s\n' "$DRAFT_LINE" > "$C/state/2.log"; echo true > "$C/state/2.running"
run_case 'docker run fails' "$C"
assert_status 1
assert_contains 'docker run failed'

# ---------------------------------------------------------------- case 5
# Both fail. The count must be 2, not 1 — the loop does not stop at the first.
C="$WORK/c5"; make_stub "$C"
echo 'nothing useful' > "$C/state/1.log"; echo false > "$C/state/1.running"
echo 'nothing useful' > "$C/state/2.log"; echo false > "$C/state/2.running"
run_case 'both fail' "$C"
assert_status 1
assert_contains '2 worker(s) failed to boot.'
assert_not_contains 'Both workers booted.'

# ---------------------------------------------------------------- case 6
# Missing image argument is a usage error (2), distinct from a boot failure.
OUT=$(sh "$UNDER_TEST" 2>&1); STATUS=$?
printf -- '--- no image argument (exit %s) ---\n' "$STATUS"
assert_status 2
assert_contains 'usage:'

printf '\n%s passed, %s failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
