#!/bin/sh
#
# Run the pgTAP suite against a plain PostgreSQL instance.
#
# WHY THIS EXISTS
#
# On 2026-08-26 a hand-rolled version of this loop reported "21 files passing,
# 0 failing" while two files were aborting with an uncaught ERROR. The check
# was `grep -c '^ERROR'`, and psql does not print errors at the start of a
# line — it prints:
#
#   psql:/path/to/file.sql:32: ERROR:  DRAFT_QUOTA_PERIOD_REQUIRED
#
# The anchor matched nothing, every error scored zero, and a false green went
# into a PR description as evidence. CI caught it, which is the system working,
# but the wasted round trip was avoidable and the claim should never have been
# made. A pass/fail parser is not something to improvise per invocation.
#
# WHAT THIS IS NOT
#
# **This is not `supabase test db`, and a pass here is weaker.** It runs against
# whatever PostgreSQL you point it at, which will not be a Supabase stack: no
# real pgmq, no GoTrue, no PostgREST, and roles you had to create by hand. Use
# it for a fast inner loop. `database-tests` in CI is the authority, and it is
# the only run that may be cited as evidence that the suite passes.
#
#   PGHOST=/tmp PGPORT=5433 PGUSER=postgres PGDATABASE=tugpt sh supabase/tests/run-local.sh
#
set -u

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")/database" && pwd)

: "${PGHOST:=/tmp}"
: "${PGPORT:=5433}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=tugpt}"
export PGHOST PGPORT PGUSER PGDATABASE

pass=0
fail=0
failed_files=''

for f in "$DIR"/*.sql; do
  name=$(basename "$f")

  # Two independent signals, because they catch different things:
  #
  #   psql exit status, under ON_ERROR_STOP=1 — the script ABORTED. This is the
  #     one the original bug missed. Do not grep for it: psql prefixes errors
  #     with "psql:<file>:<line>: ", so any start-of-line anchor scores zero.
  #   "not ok" in the output — the script RAN and an assertion FAILED. pgTAP
  #     reports these and still exits 0, so the status alone is not enough.
  out=$(psql -X -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  status=$?
  not_ok=$(printf '%s\n' "$out" | grep -c 'not ok')

  if [ "$status" -eq 0 ] && [ "$not_ok" -eq 0 ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed_files="$failed_files $name"
    printf 'FAIL  %s  (psql exit %s, %s failed assertion(s))\n' "$name" "$status" "$not_ok"
    printf '%s\n' "$out" | grep -E 'not ok|ERROR:|FATAL:' | sed 's/^/      /' | head -5
  fi
done

printf '\n%s passed, %s failed (of %s files)\n' "$pass" "$fail" "$((pass + fail))"
if [ "$fail" -ne 0 ]; then
  printf 'failed:%s\n' "$failed_files"
  exit 1
fi
printf 'Local run only. CI database-tests against the real Supabase stack is the authority.\n'
