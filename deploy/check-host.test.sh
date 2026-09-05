#!/usr/bin/env sh
#
# deploy/check-host.test.sh
#
# Tests for deploy/check-host.sh.
#
# check-host.sh exists because a prose checklist claimed the box was hardened
# when it was not. An untested checker is the same failure one level up: it
# prints "ok" and nobody knows whether that means anything. So every check in
# check-host.sh is exercised here against recorded fixtures, in both directions
# - the state that should pass and the state that should fail.
#
# The fixtures for case 1 reproduce the machine we lost: password SSH on, root
# login on, an unrelated container published on 0.0.0.0:3001, nginx holding
# 80/443, and the resolver stub that broke ACME.
#
# Run:  sh deploy/check-host.test.sh
# Exit: 0 all assertions passed, 1 otherwise.

# The stub bodies below are deliberately single-quoted: they are shell source
# written to a file and executed later, so $1/$@ must reach the stub unexpanded.
# shellcheck disable=SC2016

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SUT="$HERE/check-host.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0
CASE=""

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  [%s] %s\n' "$CASE" "$1"; }

# Assertions ignore run-length of whitespace: the column padding in check-host.sh
# is cosmetic, and pinning it here would make every message reword a test edit.
squash() { printf '%s\n' "$1" | tr -s ' \t' ' '; }

assert_has() {
  if squash "$OUT" | grep -qF "$(squash "$1")"; then pass; else fail "expected output to contain: $1"; fi
}
assert_lacks() {
  if squash "$OUT" | grep -qF "$(squash "$1")"; then fail "expected output NOT to contain: $1"; else pass; fi
}
assert_exit() {
  if [ "$RC" = "$1" ]; then pass; else fail "expected exit $1, got $RC"; fi
}
assert_counts() {
  if printf '%s\n' "$OUT" | grep -qF "$1 failed, $2 warned, $3 skipped"; then pass
  else fail "expected '$1 failed, $2 warned, $3 skipped', got: $(printf '%s\n' "$OUT" | tail -3 | head -1)"; fi
}

# --- fixture builders --------------------------------------------------------

stub() { # stub <path> <body>
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\n%s\n' "$2" > "$1"
  chmod +x "$1"
}

# The suite must give the same answer whether it runs as root locally or as an
# unprivileged CI runner, so `id` and `stat` are stubbed rather than inherited:
# check-host.sh branches on `id -u`, and fixture files created by the runner are
# owned by the runner, not root.
stub_root() { stub "$1/id" 'echo 0'; }
stub_nonroot() { stub "$1/id" 'echo 1000'; }
stub_stat() { # stub_stat <dir> <mode> <owner>
  stub "$1/stat" "case \"\$2\" in
  %a) echo $2 ;;
  %U:%G) echo $3 ;;
esac"
}

# =============================================================================
# Case 1 - the box we lost. Everything that can be wrong, is.
# =============================================================================
CASE="compromised"
D="$WORK/bad"; mkdir -p "$D"

stub "$D/sshd" 'cat <<EOF
passwordauthentication yes
permitrootlogin yes
kbdinteractiveauthentication yes
usepam yes
EOF'

stub "$D/ss" 'cat <<EOF
LISTEN 0 128    0.0.0.0:22    0.0.0.0:* users:(("sshd",pid=700,fd=3))
LISTEN 0 128    0.0.0.0:80    0.0.0.0:* users:(("nginx",pid=800,fd=6))
LISTEN 0 128    0.0.0.0:3001  0.0.0.0:* users:(("docker-proxy",pid=900,fd=4))
LISTEN 0 128       [::]:8080     [::]:* users:(("java",pid=901,fd=7))
LISTEN 0 4096 127.0.0.1:36773  0.0.0.0:* users:(("node",pid=902,fd=20))
EOF'

# docker: `info` succeeds, `ps` prints the fixture, `compose ... ps` prints caddy.
stub "$D/docker" 'case "$1" in
  info) exit 0 ;;
  ps) printf "open-webui\t0.0.0.0:3001->8080/tcp, :::3001->8080/tcp\n"
      printf "tugpt-caddy-1\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" ;;
  compose) for a in "$@"; do [ "$a" = "--services" ] && { echo caddy; exit 0; }; done
           exit 1 ;;
esac'

stub "$D/systemctl" 'verb=$1; shift
for a in "$@"; do case "$a" in --*) ;; *) unit=$a ;; esac; done
case "$verb" in
  is-active)  [ "$unit" = "nginx" ] && exit 0; exit 3 ;;
  is-enabled) case "$unit" in
                tugpt.service|tugpt-web.service) echo enabled; exit 0 ;;
              esac
              echo disabled; exit 1 ;;
esac
exit 1'

stub "$D/ufw" 'cat <<EOF
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80,443/tcp                 ALLOW       Anywhere
3001/tcp                   ALLOW       Anywhere
EOF'

stub_root "$D"; stub_stat "$D" 644 root:root
printf 'nameserver 127.0.0.53\n' > "$D/resolv.conf"

mkdir -p "$D/etc-tugpt"
printf 'X=1\n' > "$D/etc-tugpt/web.env"
chmod 644 "$D/etc-tugpt/web.env"

# A compose file whose caddy service has lost its dns: pin.
cat > "$D/docker-compose.yml" <<'EOF'
services:
  web:
    dns:
      - 1.1.1.1
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
  draft-worker:
    image: tugpt-worker:latest
EOF

OUT=$(cd "$D" && PATH="$D:$PATH" \
  SSHD_T_CMD="$D/sshd -T" SS_CMD="$D/ss" DOCKER_CMD="$D/docker" \
  DOCKER_PS_CMD="$D/docker ps" SYSTEMCTL_CMD="$D/systemctl" UFW_CMD="$D/ufw" \
  ID_CMD="$D/id" STAT_CMD="$D/stat" \
  RESOLV_CONF="$D/resolv.conf" SSHD_CONFIG="$D/sshd_config" SSHD_CONFIG_D="$D/sshd_config.d" \
  ENV_DIR="$D/etc-tugpt" REPO_DIR="$D" \
  sh "$SUT" 2>&1); RC=$?

assert_exit 1
assert_has 'FAIL  ssh.password         PasswordAuthentication YES (effective)'
assert_has 'FAIL  ssh.root             PermitRootLogin yes (effective)'
assert_has 'FAIL  ssh.kbdinteractive   KbdInteractiveAuthentication yes (effective)'
assert_has 'WARN  firewall             ufw allows ports beyond 22/80/443: 3001'
assert_has 'FAIL  listeners'
assert_has 'port 3001  on 0.0.0.0'
assert_has 'port 8080  on [::]'
assert_has 'FAIL  docker.ports'
assert_has 'open-webui: 0.0.0.0:3001->8080/tcp'
assert_has 'FAIL  webservers           another web server is active: nginx'
assert_has 'FAIL  units                tugpt.service and tugpt-web.service are both enabled'
assert_has 'FAIL  env.web.env          644 root:root - expected 600 root:root'
assert_has 'WARN  dns.host             only loopback nameservers: 127.0.0.53'
assert_has 'FAIL  dns.pinned           the caddy service no longer pins dns:'
assert_has 'FAIL  dns.acme             caddy cannot resolve'
# Ports 22 and 80 are wildcard-bound and must NOT be reported.
assert_lacks 'port 22  on'
assert_lacks 'port 80  on'
# 127.0.0.1:36773 is loopback and must NOT be reported.
assert_lacks '36773'
# The caddy container publishes 80/443 to the world on purpose.
assert_lacks 'tugpt-caddy-1:'
assert_counts 10 2 0

# =============================================================================
# Case 2 - a correctly built box. Nothing may fail.
# =============================================================================
CASE="hardened"
D="$WORK/good"; mkdir -p "$D"

stub "$D/sshd" 'cat <<EOF
passwordauthentication no
permitrootlogin prohibit-password
kbdinteractiveauthentication no
EOF'

stub "$D/ss" 'cat <<EOF
LISTEN 0 128    0.0.0.0:22    0.0.0.0:* users:(("sshd",pid=700,fd=3))
LISTEN 0 128    0.0.0.0:80    0.0.0.0:* users:(("docker-proxy",pid=800,fd=4))
LISTEN 0 128    0.0.0.0:443   0.0.0.0:* users:(("docker-proxy",pid=801,fd=4))
LISTEN 0 4096 127.0.0.1:3001  0.0.0.0:* users:(("docker-proxy",pid=802,fd=4))
EOF'

stub "$D/docker" 'case "$1" in
  info) exit 0 ;;
  ps) printf "tugpt-web-1\t127.0.0.1:3001->3000/tcp\n"
      printf "tugpt-caddy-1\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:443->443/udp\n" ;;
  compose) for a in "$@"; do [ "$a" = "--services" ] && { echo caddy; exit 0; }; done
           exit 0 ;;
esac'

stub "$D/systemctl" 'verb=$1; shift
for a in "$@"; do case "$a" in --*) ;; *) unit=$a ;; esac; done
case "$verb" in
  is-active)  exit 3 ;;
  is-enabled) case "$unit" in
                tugpt-web.service) echo enabled; exit 0 ;;
              esac
              echo disabled; exit 1 ;;
esac
exit 1'

stub "$D/ufw" 'cat <<EOF
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80,443/tcp                 ALLOW       Anywhere
EOF'

stub_root "$D"; stub_stat "$D" 600 root:root
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$D/resolv.conf"
mkdir -p "$D/etc-tugpt"
printf 'X=1\n' > "$D/etc-tugpt/web.env"; chmod 600 "$D/etc-tugpt/web.env"
printf 'X=1\n' > "$D/etc-tugpt/worker.env"; chmod 600 "$D/etc-tugpt/worker.env"
# The REAL compose file, on purpose: if somebody removes the dns: pin from the
# caddy service, this case turns red in CI as well as on the box. That coupling
# is the point, not an accident.
cp "$HERE/../docker-compose.yml" "$D/docker-compose.yml"

OUT=$(cd "$D" && PATH="$D:$PATH" \
  SSHD_T_CMD="$D/sshd -T" SS_CMD="$D/ss" DOCKER_CMD="$D/docker" \
  DOCKER_PS_CMD="$D/docker ps" SYSTEMCTL_CMD="$D/systemctl" UFW_CMD="$D/ufw" \
  ID_CMD="$D/id" STAT_CMD="$D/stat" \
  RESOLV_CONF="$D/resolv.conf" SSHD_CONFIG="$D/sshd_config" SSHD_CONFIG_D="$D/sshd_config.d" \
  ENV_DIR="$D/etc-tugpt" REPO_DIR="$D" \
  sh "$SUT" 2>&1); RC=$?

assert_exit 0
assert_counts 0 0 0
assert_has 'ok    ssh.password         PasswordAuthentication no (effective)'
assert_has 'ok    ssh.root             PermitRootLogin prohibit-password (effective)'
assert_has 'ok    ssh.kbdinteractive   KbdInteractiveAuthentication no (effective)'
assert_has 'ok    firewall             ufw active, nothing beyond 22/80/443'
assert_has 'ok    listeners            nothing on a public address outside 22/80/443'
assert_has 'ok    docker.ports'
assert_has 'ok    webservers'
assert_has 'ok    units                one web deployment enabled (web=enabled full=disabled)'
assert_has 'ok    env.web.env          600 root:root'
assert_has 'ok    env.worker.env       600 root:root'
assert_has 'ok    dns.host             nameservers: 1.1.1.1 8.8.8.8'
assert_has 'ok    dns.pinned           caddy still pins its own resolvers'
assert_has 'ok    dns.acme'

# =============================================================================
# Case 3 - a half-built box. Nothing exists yet; nothing may crash or FAIL.
# =============================================================================
CASE="half-built"
D="$WORK/empty"; mkdir -p "$D"
stub_root "$D"
printf 'nameserver 1.1.1.1\n' > "$D/resolv.conf"

OUT=$(cd "$D" && \
  SSHD_T_CMD="$D/nope-sshd -T" SS_CMD="$D/nope-ss" DOCKER_CMD="$D/nope-docker" \
  DOCKER_PS_CMD="$D/nope-docker ps" SYSTEMCTL_CMD="$D/nope-systemctl" UFW_CMD="$D/nope-ufw" \
  ID_CMD="$D/id" STAT_CMD="$D/nope-stat" \
  RESOLV_CONF="$D/resolv.conf" SSHD_CONFIG="$D/nope" SSHD_CONFIG_D="$D/nope.d" \
  ENV_DIR="$D/nope-etc" REPO_DIR="$D/nope-repo" \
  sh "$SUT" 2>&1); RC=$?

assert_exit 0
assert_has 'skip  ssh                  no sshd on this host'
assert_has 'skip  listeners            ss not installed'
assert_has 'skip  docker.ports         docker not installed'
assert_has 'skip  webservers           no systemctl'
assert_has 'skip  units                no systemctl'
assert_has 'skip  env                  no env files in'
assert_has 'skip  dns.pinned           docker-compose.yml not found'
assert_has 'skip  dns.acme             docker not installed'
assert_has 'WARN  firewall             ufw is not installed'
assert_has 'skip is not a pass'
assert_counts 0 1 8

# =============================================================================
# Case 4 - the drop-in trap: a clean sshd_config overridden by a drop-in.
# This is the shape of the failure that lost the box, and the reason the
# file-only path emits a warning about its own evidence.
# =============================================================================
CASE="drop-in-override"
D="$WORK/dropin"; mkdir -p "$D/sshd_config.d"
cat > "$D/sshd_config" <<'EOF'
# looks right
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
EOF
cat > "$D/sshd_config.d/50-cloud-init.conf" <<'EOF'
PasswordAuthentication yes
EOF
stub_root "$D"
printf 'nameserver 1.1.1.1\n' > "$D/resolv.conf"

# No sshd binary: forces the file-only path even as root.
OUT=$(cd "$D" && \
  SSHD_T_CMD="$D/nope-sshd -T" SS_CMD="$D/nope-ss" DOCKER_CMD="$D/nope-docker" \
  DOCKER_PS_CMD="$D/nope-docker ps" SYSTEMCTL_CMD="$D/nope-systemctl" UFW_CMD="$D/nope-ufw" \
  ID_CMD="$D/id" STAT_CMD="$D/nope-stat" \
  RESOLV_CONF="$D/resolv.conf" SSHD_CONFIG="$D/sshd_config" SSHD_CONFIG_D="$D/sshd_config.d" \
  ENV_DIR="$D/nope-etc" REPO_DIR="$D/nope-repo" \
  sh "$SUT" 2>&1); RC=$?

assert_exit 1
assert_has 'WARN  ssh                  reading config text, not the effective config'
assert_has 'FAIL  ssh.password         PasswordAuthentication YES (file-only)'
assert_has 'ok    ssh.root             PermitRootLogin no (file-only)'
assert_has 'ok    ssh.kbdinteractive   KbdInteractiveAuthentication no (file-only)'

# =============================================================================
# Case 5 - run without root. Checks that need privilege must say so rather than
# report a false ok. Same fixtures as case 2 (a correctly built box), so any
# FAIL here is the loss of privilege being misreported as a problem.
# =============================================================================
CASE="non-root"
D="$WORK/good"
stub_nonroot "$D"

OUT=$(cd "$D" && PATH="$D:$PATH" \
  SSHD_T_CMD="$D/sshd -T" SS_CMD="$D/ss" DOCKER_CMD="$D/docker" \
  DOCKER_PS_CMD="$D/docker ps" SYSTEMCTL_CMD="$D/systemctl" UFW_CMD="$D/ufw" \
  ID_CMD="$D/id" STAT_CMD="$D/stat" \
  RESOLV_CONF="$D/resolv.conf" SSHD_CONFIG="$D/sshd_config" SSHD_CONFIG_D="$D/sshd_config.d" \
  ENV_DIR="$D/etc-tugpt" REPO_DIR="$D" \
  sh "$SUT" 2>&1); RC=$?

assert_exit 0
assert_has 'NOT root - some checks degrade'
assert_has 'skip  firewall             ufw status needs root'
# No sshd_config fixture exists in this directory and sshd -T is not consulted
# without root, so the values are unknown - and unknown must not read as fine.
assert_has 'WARN  ssh                  reading config text, not the effective config'
assert_has "WARN  ssh.password         PasswordAuthentication not determined - sshd's own default is yes"
assert_lacks 'ok    ssh.password'

# =============================================================================
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
