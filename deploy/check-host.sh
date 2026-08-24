#!/usr/bin/env sh
#
# deploy/check-host.sh
#
# Section 5.2 of docs/production_environment.md, as something that runs.
#
# 5.2 was a prose checklist. Its first item was "SSH key-based auth is enabled
# and password auth is disabled." On 2026-08-24 the server was compromised with
# root password SSH still enabled, and the box had to be reinstalled. The item
# was never ticked, and nothing anywhere would have said so. A checklist only
# works if somebody reads it; a script that exits non-zero works whether or not
# anybody does.
#
# Every check runs. A failure prints what it found and what to do about it, and
# the script carries on to the next one - you get the whole picture from one
# run, not one problem at a time. Nothing here changes anything on the host.
#
# Designed to be run on a HALF-BUILT box. Anything it cannot determine yet
# (Docker not installed, the stack not up, /etc/tugpt not created) is reported
# as `skip` with the reason, not as a failure. `skip` is not a pass - it means
# come back and run this again once that part exists.
#
# Usage:
#
#   sudo sh deploy/check-host.sh
#
# Run it as root. Several checks (the effective sshd config, the process names
# behind listening sockets, ufw status) are root-only, and without root they
# degrade to weaker evidence and say so rather than reporting a false ok.
#
# Invoked as `sh <path>` rather than `./<path>` on purpose: this file arrives
# through the GitHub API, which writes blobs as 0644, so the executable bit does
# not survive a fresh clone.
#
# Exit codes: 0 nothing failed, 1 at least one FAIL, 2 the script could not run.
#
# deploy/check-host.test.sh exercises every check in here against recorded
# fixtures, including a fixture of the exact sshd configuration the box was lost
# with. Run it after changing anything below.

set -u   # deliberately NOT -e: one failing check must not end the run

# --- test seams --------------------------------------------------------------
# Each is a command line, word-split on use. Leave them unset in real use.
#
# Assigned in two steps rather than with ${VAR:-default}: a default value
# containing `}` (a Go template, e.g. {{.Names}}) terminates the expansion
# early and silently mangles the command. That bug was in the first draft of
# this file and produced `--format {{.Names}` - a template Docker rejects.
[ -n "${SSHD_T_CMD:-}" ]    || SSHD_T_CMD='sshd -T'
[ -n "${SS_CMD:-}" ]        || SS_CMD='ss -H -tlnp'
[ -n "${DOCKER_PS_CMD:-}" ] || DOCKER_PS_CMD='docker ps --format {{.Names}}\t{{.Ports}}'
[ -n "${SYSTEMCTL_CMD:-}" ] || SYSTEMCTL_CMD='systemctl'
[ -n "${UFW_CMD:-}" ]       || UFW_CMD='ufw'
[ -n "${DOCKER_CMD:-}" ]    || DOCKER_CMD='docker'
[ -n "${RESOLV_CONF:-}" ]   || RESOLV_CONF='/etc/resolv.conf'
[ -n "${SSHD_CONFIG:-}" ]   || SSHD_CONFIG='/etc/ssh/sshd_config'
[ -n "${SSHD_CONFIG_D:-}" ] || SSHD_CONFIG_D='/etc/ssh/sshd_config.d'
[ -n "${ID_CMD:-}" ]        || ID_CMD='id'
[ -n "${STAT_CMD:-}" ]      || STAT_CMD='stat'

REPO_DIR="${REPO_DIR:-/opt/tugpt}"
ENV_DIR="${ENV_DIR:-/etc/tugpt}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-tugpt}"
ACME_HOST="${ACME_HOST:-acme-v02.api.letsencrypt.org}"

# Ports that are allowed to face the internet. Everything else must be bound to
# loopback and reached through the proxy.
PUBLIC_PORTS="22 80 443"

FAILED=0
WARNED=0
SKIPPED=0
IS_ROOT=0
[ "$($ID_CMD -u)" = "0" ] && IS_ROOT=1

ok()   { printf 'ok    %-20s %s\n' "$1" "$2"; }
warn() { printf 'WARN  %-20s %s\n' "$1" "$2"; WARNED=$((WARNED + 1)); }
bad()  { printf 'FAIL  %-20s %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }
skip() { printf 'skip  %-20s %s\n' "$1" "$2"; SKIPPED=$((SKIPPED + 1)); }
note() { printf '      %-20s %s\n' '' "$1"; }

# Note the variable name. An earlier version looped over `p`, which is also the
# variable check_firewall reads ports into - so a miss left the caller's `p` set
# to the last PUBLIC_PORT and the warning named 443 when 3001 was the port open.
# A checker that reports the wrong port is worse than one that reports nothing.
is_public_port() {
  _ipp_want="$1"
  for _ipp_have in $PUBLIC_PORTS; do
    [ "$_ipp_want" = "$_ipp_have" ] && return 0
  done
  return 1
}

# Is the first word of a seam actually runnable?
have() {
  # shellcheck disable=SC2086
  set -- $1
  command -v "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 1. SSH. The one that mattered.
# ---------------------------------------------------------------------------
check_ssh() {
  if [ ! -f "$SSHD_CONFIG" ] && ! have "$SSHD_T_CMD"; then
    skip "ssh" "no sshd on this host"
    return
  fi

  # `sshd -T` is the only authoritative source: it resolves Include directives
  # and $SSHD_CONFIG_D drop-ins. Cloud images routinely ship a drop-in that
  # re-enables password auth, so a correct-looking sshd_config proves nothing on
  # its own. That is very likely how "we disabled passwords" and "passwords are
  # enabled" were both true on the old box.
  effective=""
  if [ "$IS_ROOT" = "1" ] && have "$SSHD_T_CMD"; then
    effective=$($SSHD_T_CMD 2>/dev/null)
  fi

  if [ -n "$effective" ]; then
    src="effective"
    pw=$(printf '%s\n' "$effective"   | awk '$1=="passwordauthentication"{print $2}'          | tail -1)
    root=$(printf '%s\n' "$effective" | awk '$1=="permitrootlogin"{print $2}'                 | tail -1)
    kbd=$(printf '%s\n' "$effective"  | awk '$1=="kbdinteractiveauthentication"{print $2}'    | tail -1)
  else
    src="file-only"
    pw=$(sshd_config_value PasswordAuthentication)
    root=$(sshd_config_value PermitRootLogin)
    kbd=$(sshd_config_value KbdInteractiveAuthentication)
    warn "ssh" "reading config text, not the effective config - re-run as root"
    note "sshd -T resolves drop-ins in $SSHD_CONFIG_D/, which is where a cloud"
    note "image commonly re-enables what the main file turned off."
  fi

  case "${pw:-unset}" in
    no)  ok   "ssh.password" "PasswordAuthentication no ($src)" ;;
    yes) bad  "ssh.password" "PasswordAuthentication YES ($src) - this is how the box was lost"
         note "sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' $SSHD_CONFIG"
         note "then check $SSHD_CONFIG_D/ for a drop-in overriding it, then: systemctl reload ssh" ;;
    *)   warn "ssh.password" "PasswordAuthentication not determined - sshd's own default is yes" ;;
  esac

  case "${root:-unset}" in
    no|prohibit-password|without-password)
         ok   "ssh.root" "PermitRootLogin $root ($src)" ;;
    yes) bad  "ssh.root" "PermitRootLogin yes ($src) - root reachable over the network"
         note "Set 'PermitRootLogin no' and use a sudo-capable account, or at minimum"
         note "'prohibit-password' so only keys work." ;;
    *)   warn "ssh.root" "PermitRootLogin not determined" ;;
  esac

  # PasswordAuthentication no is not enough on its own: with PAM enabled,
  # keyboard-interactive is a second door to the same password.
  case "${kbd:-unset}" in
    no)  ok   "ssh.kbdinteractive" "KbdInteractiveAuthentication no ($src)" ;;
    yes) bad  "ssh.kbdinteractive" "KbdInteractiveAuthentication yes ($src) - passwords still reachable"
         note "With PAM this accepts the same password even when PasswordAuthentication is no." ;;
    *)   warn "ssh.kbdinteractive" "KbdInteractiveAuthentication not determined" ;;
  esac
}

# Last uncommented setting of a keyword across the main file and the drop-in
# directory. Weaker than `sshd -T` - it does not honour Match blocks or Include
# ordering - which is why using it emits a WARN above.
sshd_config_value() {
  grep -rhiE "^[[:space:]]*$1[[:space:]]" "$SSHD_CONFIG" "$SSHD_CONFIG_D" 2>/dev/null \
    | awk '{print tolower($2)}' | tail -1
}

# ---------------------------------------------------------------------------
# 2. Firewall
# ---------------------------------------------------------------------------
check_firewall() {
  if ! have "$UFW_CMD"; then
    warn "firewall" "ufw is not installed - no host firewall to inspect"
    note "If you use something else, verify by hand that only 22/80/443 are open."
    return
  fi
  if [ "$IS_ROOT" != "1" ]; then
    skip "firewall" "ufw status needs root"
    return
  fi

  status=$($UFW_CMD status 2>/dev/null)
  if ! printf '%s\n' "$status" | grep -qi 'Status: active'; then
    bad "firewall" "ufw is installed but not active"
    note "sudo ufw allow 22,80,443/tcp && sudo ufw enable"
    return
  fi

  extra=$(printf '%s\n' "$status" | awk '/ALLOW/ {print $1}' | sed 's#/.*##' | tr ',' '\n' \
          | grep -E '^[0-9]+$' | sort -un \
          | while read -r ufwport; do is_public_port "$ufwport" || printf '%s ' "$ufwport"; done \
          | sed 's/ *$//')
  if [ -n "$extra" ]; then
    warn "firewall" "ufw allows ports beyond 22/80/443: $extra"
    note "Each one is a decision - confirm it is meant to be internet-reachable."
  else
    ok "firewall" "ufw active, nothing beyond 22/80/443"
  fi
}

# ---------------------------------------------------------------------------
# 3. What is actually listening on a public address
# ---------------------------------------------------------------------------
check_listeners() {
  if ! have "$SS_CMD"; then
    skip "listeners" "ss not installed (apt-get install iproute2)"
    return
  fi
  [ "$IS_ROOT" = "1" ] || note "(not root: listening sockets shown without process names)"

  out=$($SS_CMD 2>/dev/null)
  if [ -z "$out" ]; then
    skip "listeners" "ss returned nothing"
    return
  fi

  # Field 4 is Local Address:Port. A wildcard address means the internet can
  # reach it, subject only to the firewall - and Docker can bypass the firewall.
  unexpected=$(printf '%s\n' "$out" | awk -v allowed=" $PUBLIC_PORTS " '
    {
      addr = $4
      n = split(addr, parts, ":")
      port = parts[n]
      host = substr(addr, 1, length(addr) - length(port) - 1)
      if (host != "0.0.0.0" && host != "*" && host != "[::]" && host != "::") next
      if (index(allowed, " " port " ") > 0) next
      proc = ""
      for (i = 5; i <= NF; i++) if ($i ~ /users:/) proc = $i
      print port "\t" host "\t" proc
    }')

  if [ -n "$unexpected" ]; then
    bad "listeners" "listening on a public address outside 22/80/443:"
    printf '%s\n' "$unexpected" | while IFS="$(printf '\t')" read -r port host proc; do
      [ -n "$port" ] && note "$(printf 'port %s  on %s  %s' "$port" "$host" "$proc" | sed 's/ *$//')"
    done
    note "The web container must bind 127.0.0.1:3001. Only Caddy should face the internet."
  else
    ok "listeners" "nothing on a public address outside 22/80/443"
  fi
}

# ---------------------------------------------------------------------------
# 4. Docker published ports
# ---------------------------------------------------------------------------
check_docker_ports() {
  if ! have "$DOCKER_CMD"; then
    skip "docker.ports" "docker not installed"
    return
  fi
  if ! $DOCKER_CMD info >/dev/null 2>&1; then
    skip "docker.ports" "docker daemon not reachable"
    return
  fi

  # Docker writes its own iptables rules and can publish a port to the world
  # even when ufw says otherwise, so what a container publishes matters more
  # than what the firewall claims. An unrelated open-webui container published
  # on 3001 was found on this host on 2026-08-24.
  rows=$($DOCKER_PS_CMD 2>/dev/null)
  if [ -z "$rows" ]; then
    skip "docker.ports" "no containers running"
    return
  fi

  found=$(printf '%s\n' "$rows" | awk -F'\t' -v allowed=" $PUBLIC_PORTS " '
    {
      name = $1
      n = split($2, maps, ",")
      for (i = 1; i <= n; i++) {
        m = maps[i]
        gsub(/^[ \t]+|[ \t]+$/, "", m)
        if (m !~ /^0\.0\.0\.0:/ && m !~ /^\[::\]:/) continue
        if (m !~ /->/) continue
        hostport = m
        sub(/->.*$/, "", hostport)
        sub(/^.*:/, "", hostport)
        if (index(allowed, " " hostport " ") > 0) continue
        print name "\t" m
      }
    }')

  if [ -n "$found" ]; then
    bad "docker.ports" "containers publishing to the internet outside 80/443:"
    printf '%s\n' "$found" | while IFS="$(printf '\t')" read -r name mapping; do
      [ -n "$name" ] && note "$name: $mapping"
    done
    note "Publish as 127.0.0.1:PORT:PORT so only the host can reach it."
  else
    ok "docker.ports" "no container publishes beyond loopback except 80/443"
  fi
}

# ---------------------------------------------------------------------------
# 5. Other web servers competing for 80/443
# ---------------------------------------------------------------------------
check_web_servers() {
  if ! have "$SYSTEMCTL_CMD"; then
    skip "webservers" "no systemctl"
    return
  fi
  hit=""
  for svc in nginx apache2 httpd lighttpd caddy; do
    $SYSTEMCTL_CMD is-active --quiet "$svc" 2>/dev/null && hit="$hit $svc"
  done
  if [ -n "$hit" ]; then
    bad "webservers" "another web server is active:$hit"
    note "Caddy runs as a container here. A host web server takes 80/443 and the"
    note "container fails to bind. Stop AND disable it - a stopped-but-enabled"
    note "nginx reclaims the ports on the next reboot:"
    note "  sudo systemctl disable --now$hit"
  else
    ok "webservers" "no host web server competing for 80/443"
  fi
}

# ---------------------------------------------------------------------------
# 6. Conflicting TuGPT units (the double-consume trap)
# ---------------------------------------------------------------------------
check_units() {
  if ! have "$SYSTEMCTL_CMD"; then
    skip "units" "no systemctl"
    return
  fi
  full=$($SYSTEMCTL_CMD is-enabled tugpt.service 2>/dev/null | tail -1)
  web=$($SYSTEMCTL_CMD is-enabled tugpt-web.service 2>/dev/null | tail -1)
  wa=$($SYSTEMCTL_CMD is-enabled tugpt-whatsapp-worker.service 2>/dev/null | tail -1)
  dr=$($SYSTEMCTL_CMD is-enabled tugpt-draft-worker.service 2>/dev/null | tail -1)

  if [ "$full" = "enabled" ] && [ "$web" = "enabled" ]; then
    bad "units" "tugpt.service and tugpt-web.service are both enabled"
    note "tugpt.service brings up the whole stack including worker containers."
  elif [ "$full" = "enabled" ] && { [ "$wa" = "enabled" ] || [ "$dr" = "enabled" ]; }; then
    bad "units" "tugpt.service is enabled alongside the native workers"
    note "Two consumers on whatsapp_inbound and draft_generation double-process"
    note "every message. See section 5.4 - the cutover is one sequence, not both."
  elif [ "$web" = "enabled" ] || [ "$full" = "enabled" ]; then
    ok "units" "one web deployment enabled (web=$web full=$full)"
  else
    skip "units" "no tugpt unit enabled yet"
  fi
}

# ---------------------------------------------------------------------------
# 7. Secrets on disk
# ---------------------------------------------------------------------------
check_env_files() {
  any=0
  for f in "$ENV_DIR/web.env" "$ENV_DIR/worker.env"; do
    [ -f "$f" ] || continue
    any=1
    mode=$($STAT_CMD -c '%a' "$f" 2>/dev/null)
    owner=$($STAT_CMD -c '%U:%G' "$f" 2>/dev/null)
    if [ "$mode" = "600" ] && [ "$owner" = "root:root" ]; then
      ok "env.$(basename "$f")" "$mode $owner"
    else
      bad "env.$(basename "$f")" "$mode $owner - expected 600 root:root"
      note "sudo chown root:root $f && sudo chmod 600 $f"
    fi
  done
  [ "$any" = "0" ] && skip "env" "no env files in $ENV_DIR yet"
  return 0
}

# ---------------------------------------------------------------------------
# 8. Host resolver, which decides whether containers can resolve anything
# ---------------------------------------------------------------------------
check_resolver() {
  [ -f "$RESOLV_CONF" ] || { skip "dns.host" "no $RESOLV_CONF"; return; }
  servers=$(awk '$1=="nameserver"{printf "%s ", $2}' "$RESOLV_CONF" | sed 's/ *$//')
  [ -z "$servers" ] && { bad "dns.host" "$RESOLV_CONF lists no nameserver"; return; }

  nonloop=0
  for s in $servers; do
    case "$s" in 127.*|::1) ;; *) nonloop=1 ;; esac
  done

  if [ "$nonloop" = "1" ]; then
    ok "dns.host" "nameservers: $servers"
  else
    warn "dns.host" "only loopback nameservers: $servers"
    note "That is the systemd-resolved stub. Docker normally substitutes public"
    note "resolvers when it sees this, but on 2026-08-24 it did not and the Caddy"
    note "container had no DNS, so the first ACME challenge failed. The compose"
    note "file now pins resolvers on caddy (see dns.pinned below), which is why"
    note "this is a warning and not a failure."
    note "Fix at the host too: ln -sf ../run/systemd/resolve/resolv.conf $RESOLV_CONF"
  fi
}

# ---------------------------------------------------------------------------
# 9. Has the resolver pin been removed from the compose file? (drift)
# ---------------------------------------------------------------------------
check_dns_pin() {
  compose="$REPO_DIR/docker-compose.yml"
  [ -f "$compose" ] || compose="./docker-compose.yml"
  [ -f "$compose" ] || { skip "dns.pinned" "docker-compose.yml not found"; return; }

  # Read the caddy service block only: from '  caddy:' to the next service key.
  if awk '/^  caddy:/{f=1;next} /^  [a-z][a-z0-9-]*:/{f=0} f' "$compose" | grep -q '^[[:space:]]*dns:'; then
    ok "dns.pinned" "caddy still pins its own resolvers"
  else
    bad "dns.pinned" "the caddy service no longer pins dns: ($compose)"
    note "Without it the container inherits the host's /etc/resolv.conf, and a"
    note "broken resolver fails renewals silently for weeks before the site drops."
  fi
}

# ---------------------------------------------------------------------------
# 10. Can Caddy actually reach Let's Encrypt right now?
# ---------------------------------------------------------------------------
check_acme() {
  have "$DOCKER_CMD" || { skip "dns.acme" "docker not installed"; return; }
  $DOCKER_CMD info >/dev/null 2>&1 || { skip "dns.acme" "docker daemon not reachable"; return; }

  if ! $DOCKER_CMD compose -p "$COMPOSE_PROJECT" --profile proxy ps --status running --services 2>/dev/null \
       | grep -qx caddy; then
    skip "dns.acme" "caddy not running yet - re-run after 5.4b"
    return
  fi

  if $DOCKER_CMD compose -p "$COMPOSE_PROJECT" --profile proxy exec -T caddy \
       nslookup "$ACME_HOST" >/dev/null 2>&1; then
    ok "dns.acme" "caddy resolves $ACME_HOST"
    note "deploy/caddy/check-cert.sh covers this on an ongoing basis, with expiry."
  else
    bad "dns.acme" "caddy cannot resolve $ACME_HOST"
    note "Renewals will fail silently until the certificate expires."
    note "  docker compose -p $COMPOSE_PROJECT --profile proxy exec caddy cat /etc/resolv.conf"
  fi
}

# ---------------------------------------------------------------------------

printf 'TuGPT host check - docs/production_environment.md section 5.2\n'
printf 'host: %s   %s\n\n' "$(hostname 2>/dev/null || echo '?')" \
  "$([ "$IS_ROOT" = "1" ] && echo 'running as root' || echo 'NOT root - some checks degrade')"

check_ssh
check_firewall
check_listeners
check_docker_ports
check_web_servers
check_units
check_env_files
check_resolver
check_dns_pin
check_acme

printf '\n%s failed, %s warned, %s skipped\n' "$FAILED" "$WARNED" "$SKIPPED"
if [ "$SKIPPED" -gt 0 ]; then
  printf 'skip is not a pass - re-run once those parts of the box exist.\n'
fi

[ "$FAILED" -gt 0 ] && exit 1
exit 0
