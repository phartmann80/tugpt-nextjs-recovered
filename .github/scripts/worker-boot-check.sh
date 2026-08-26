#!/bin/sh
#
# Start the worker image and prove both entrypoints reach their start line.
#
# This is the check that was missing on 2026-08-25. CI built the worker image
# on every PR and never once ran it, so an image that crash-looped at boot
# passed every gate and was only discovered by deploying it. Building an
# artifact is not evidence that it starts.
#
#   sh .github/scripts/worker-boot-check.sh <image-tag>
#
# Environment is deliberately stubbed, not real: NEXT_PUBLIC_SUPABASE_URL
# points at a closed port. Both workers require that variable to exist or they
# exit(1) before main(), and both survive a failing poll — they log the error
# and keep looping. So a stub is enough to separate "the process starts" from
# "the process can reach Supabase", and this check only claims the first.
#
# The WhatsApp worker is started with NO command, so it exercises the image's
# own CMD. The compose commands are kept in agreement with that CMD by
# apps/worker/tests/worker-start-command.test.ts, which means booting CMD here
# covers the path compose actually takes.
#
# `set -u` but deliberately not `set -e`: every check runs even after one
# fails, so a red build reports both workers rather than the first.
set -u

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

# Seconds to wait for a start line. Generous: a cold container on a shared CI
# runner is slow, and a flaky timeout here would train people to ignore it.
BOOT_TIMEOUT_SECONDS="${BOOT_TIMEOUT_SECONDS:-90}"

# Reserved-by-convention closed port. Any connection fails fast rather than
# hanging, which keeps the failing-poll path quick.
STUB_SUPABASE_URL='http://127.0.0.1:1'

failures=0

# boot <label> <needle> [command...]
#
# Runs the image detached, waits for <needle> in its logs, then confirms the
# container is still running. Both halves matter: a process that prints its
# start line and immediately dies is still broken.
boot() {
  label="$1"
  needle="$2"
  shift 2

  cid=$(docker run -d \
    -e NEXT_PUBLIC_SUPABASE_URL="$STUB_SUPABASE_URL" \
    -e SUPABASE_SERVICE_ROLE_KEY=stub-service-role-key \
    -e WORKER_POLL_INTERVAL_MS=60000 \
    -e DRAFT_WORKER_POLL_INTERVAL_MS=60000 \
    "$IMAGE" "$@") || {
    echo "FAIL  $label  docker run failed"
    failures=$((failures + 1))
    return
  }

  found=0
  elapsed=0
  while [ "$elapsed" -lt "$BOOT_TIMEOUT_SECONDS" ]; do
    if docker logs "$cid" 2>&1 | grep -qF -- "$needle"; then
      found=1
      break
    fi
    # If it has already exited, waiting longer cannot help. Look once more in
    # case the line landed in the same instant, then stop.
    if [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]; then
      docker logs "$cid" 2>&1 | grep -qF -- "$needle" && found=1
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  running=$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null)

  if [ "$found" -eq 1 ] && [ "$running" = "true" ]; then
    echo "ok    $label  reached its start line in ${elapsed}s and is still running"
  else
    failures=$((failures + 1))
    if [ "$found" -eq 1 ]; then
      echo "FAIL  $label  printed its start line and then exited (code $exit_code)"
    else
      echo "FAIL  $label  never printed: $needle"
      echo "      running=$running exitCode=$exit_code after ${elapsed}s"
    fi
    echo "----- $label logs -----"
    docker logs "$cid" 2>&1 | tail -40
    echo "----- end $label logs -----"
  fi

  docker rm -f "$cid" >/dev/null 2>&1 || true
}

echo "Booting $IMAGE (timeout ${BOOT_TIMEOUT_SECONDS}s per worker)"
echo

# No command: this is the image's CMD, i.e. the WhatsApp worker.
boot 'whatsapp-worker (image CMD)' 'Worker started. Polling whatsapp_inbound queue...'

# The draft worker is the same image under a different command.
boot 'draft-worker' '"message":"Draft worker started"' node dist/draft-index.js

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures worker(s) failed to boot."
  echo
  echo "The usual cause is a packaging change: every @tugpt/* package must build"
  echo "to dist/ and point \"main\" there, or the compiled worker resolves them to"
  echo "raw TypeScript and dies with ERR_MODULE_NOT_FOUND before main()."
  exit 1
fi

echo 'Both workers booted.'
