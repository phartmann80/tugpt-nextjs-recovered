#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DB_NAME="tugpt_test"

echo "=== Resetting database ==="
bash "$SCRIPT_DIR/reset_db.sh"

echo "=== Applying migrations ==="
for f in "$REPO_DIR"/supabase/migrations/*.sql; do
  echo "  Applying: $(basename $f)"
  sudo -u postgres psql -d $DB_NAME -f "$f" 2>&1 | grep -E "ERROR|FATAL" && exit 1 || true
done

echo ""
echo "=== Running pgTAP tests ==="
TOTAL_TESTS=0
FAILED=0
for f in "$REPO_DIR"/supabase/tests/database/*.sql; do
  RESULT=$(sudo -u postgres pg_prove -d $DB_NAME "$f" 2>&1)
  TESTS=$(echo "$RESULT" | grep -oP 'Tests=\K\d+')
  STATUS=$(echo "$RESULT" | grep -oP 'Result: \K\w+')
  echo "  $(basename $f): $STATUS ($TESTS tests)"
  if [ "$STATUS" != "PASS" ]; then
    FAILED=$((FAILED + 1))
    echo "$RESULT" | grep "Failed test"
  fi
  TOTAL_TESTS=$((TOTAL_TESTS + TESTS))
done

echo ""
echo "=== Summary: $TOTAL_TESTS total tests, $FAILED failed files ==="
