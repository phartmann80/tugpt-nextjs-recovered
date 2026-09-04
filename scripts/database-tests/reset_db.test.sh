#!/usr/bin/env sh
#
# scripts/database-tests/reset_db.test.sh
#
# Tests for reset_db.sh.
#
# reset_db.sh builds a lookalike of the database CI runs against. On
# 2026-09-03 it reported green on six pull requests whose database-tests job
# was red, because it differed from CI in two specific ways. Both were fixed.
# A fix nobody tests is the same failure one level up, so both are asserted
# here -- in both directions, against a copy of the script with the property
# removed.
#
# No database and no network: these assertions are about what the script asks
# Postgres for, which is where both defects lived. The behaviour of the
# resulting database is what the pgTAP suite is for.
#
# Run:  sh scripts/database-tests/reset_db.test.sh
# Exit: 0 all assertions passed, 1 otherwise.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SUT="$HERE/reset_db.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }

assert_contains() {
  if printf '%s' "$2" | grep -q -- "$3"; then pass; else fail "$1"; fi
}
assert_not_contains() {
  if printf '%s' "$2" | grep -q -- "$3"; then fail "$1"; else pass; fi
}

SRC=$(cat "$SUT")

# --- 1. the script exists and is a shell script -----------------------------

assert_contains "reset_db.sh is missing or not a shell script" "$SRC" '#!/bin/bash'

# --- 2. FIDELITY: default privileges ----------------------------------------
#
# Supabase grants ALL on future public tables to these roles. Without that, a
# migration that GRANTs a subset and REVOKEs nothing produces a table with
# exactly the subset here and ALL in production -- which is how service_role
# kept TRUNCATE and TRIGGER on the encrypted credential tables.

assert_contains "reset_db.sh no longer sets default privileges on TABLES" \
  "$SRC" 'ALTER DEFAULT PRIVILEGES IN SCHEMA public'
assert_contains "default table privileges do not grant ALL" \
  "$SRC" 'GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role'
assert_contains "default privileges omit service_role" \
  "$SRC" 'service_role'

# service_role alone is not enough: anon and authenticated hold the same
# defaults in a real project, and the assertions that caught this compare the
# exact privilege set for all three roles.
for role in anon authenticated service_role; do
  if printf '%s' "$SRC" \
     | grep 'GRANT ALL ON TABLES TO' | grep -q "$role"; then pass
  else fail "default table privileges omit $role"; fi
done

# --- 3. FIDELITY: collation -------------------------------------------------
#
# CI uses glibc en_US.UTF-8, which ignores punctuation at the primary level.
# A database created with no locale clause inherits the cluster default --
# usually C -- and sorts 'gpt-5-mini' before 'gpt-5.1' instead of after.

assert_contains "reset_db.sh does not request a linguistic collation" \
  "$SRC" 'ICU_LOCALE'
assert_contains "the ICU locale is not the shifted variant that matches CI" \
  "$SRC" 'en-US-u-ka-shifted'
assert_contains "there is no en_US.UTF-8 fallback" \
  "$SRC" "LC_COLLATE 'en_US.UTF-8'"
assert_contains "a collation-blind fallback does not warn" \
  "$SRC" 'WARNING: collation-dependent test failures will NOT be caught here.'

# The bare form must not be the FIRST thing tried: if it is, the locale clauses
# below it are unreachable and the script silently loses the property.
FIRST_CREATE=$(printf '%s\n' "$SRC" | grep -n 'CREATE DATABASE' | head -1)
assert_contains "first CREATE DATABASE lacks a locale clause" "$FIRST_CREATE" 'TEMPLATE template0'

# --- 4. the warning banner is present ---------------------------------------
#
# The single most load-bearing line in the file: this harness is not a gate.
# It was treated as one for six pull requests.

assert_contains "reset_db.sh no longer says it is not a gate" \
  "$SRC" 'THIS IS AN APPROXIMATION OF CI, NOT A GATE'
assert_contains "README.md is missing" "$(ls "$HERE")" 'README.md'
# Matched on a single line: the phrase this originally grepped for wraps in the
# README, so the assertion failed against text that was actually present. A
# multi-line grep pattern is a test that fails on reflow rather than on meaning.
assert_contains "README does not say this is not a gate" \
  "$(cat "$HERE/README.md")" 'It is not a gate'
assert_contains "README does not say CI wins on disagreement" \
  "$(cat "$HERE/README.md")" 'CI is'

# --- 5. negative controls ---------------------------------------------------
#
# Every assertion above is a grep for a string that is currently present, so
# each would pass against a file that merely mentions it. These re-run the two
# fidelity checks against copies with the property deleted, which is the only
# way to know the assertions are load-bearing rather than decorative.

STRIPPED_PRIVS="$WORK/no_privs.sh"
grep -v 'ALTER DEFAULT PRIVILEGES IN SCHEMA public' "$SUT" \
  | grep -v 'GRANT ALL ON TABLES TO postgres' > "$STRIPPED_PRIVS"
assert_not_contains "negative control: stripped privileges string remained" "$(cat "$STRIPPED_PRIVS")" 'GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role'

STRIPPED_COLL="$WORK/no_coll.sh"
grep -v 'ICU_LOCALE' "$SUT" > "$STRIPPED_COLL"
assert_not_contains "negative control: stripped ICU locale remained" "$(cat "$STRIPPED_COLL")" 'ICU_LOCALE'

# --- 6. run_all_tests.sh still points at this script ------------------------

assert_contains "run_all_tests.sh no longer calls reset_db.sh" \
  "$(cat "$HERE/run_all_tests.sh")" 'reset_db.sh'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
