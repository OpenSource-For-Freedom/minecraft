#!/usr/bin/env bash
# Post NEW security events from this droplet to Discord.
#
# Installed at /usr/local/bin/mc-security-alert and run by a systemd timer.
# See alerts/install_alerts.sh.
#
# THREAT MODEL, because this puts a credential on the server.
#
# The webhook is a bearer token: whoever holds it can post to the channel. It
# lives in /etc/minecraft-alerts.env, root-owned and chmod 600, OUTSIDE the git
# repo and OUTSIDE the container. The Minecraft server runs as uid 1000 with a
# read-only rootfs and every capability dropped, so a compromise of the game
# does not reach it.
#
# What an attacker gains by stealing it: the ability to post messages to a
# private Discord channel, and to spam it. That is annoying, not dangerous. What
# they do NOT gain is any access back into the droplet, because a webhook is
# write-only and one-directional. Discord cannot send commands through it.
#
# That asymmetry is the whole reason this is acceptable: alerts push OUT. The
# alternative, letting something outside reach IN to collect them, would mean
# opening a port or storing an SSH credential in CI, and both are worse.
#
# If the webhook is ever suspected leaked: delete it in Discord (Server
# Settings, Integrations, Webhooks) and run install_alerts.sh again. Rotation is
# one command and invalidates the old URL instantly.
set -uo pipefail

ENV_FILE="/etc/minecraft-alerts.env"
STATE_DIR="/var/lib/mc-alerts"
STATE="$STATE_DIR/last-run"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo droplet)"

[ -r "$ENV_FILE" ] || { echo "no $ENV_FILE; run install_alerts.sh" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${DISCORD_WEBHOOK:-}" ] || { echo "DISCORD_WEBHOOK unset in $ENV_FILE" >&2; exit 1; }

mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
SINCE="$(cat "$STATE" 2>/dev/null || echo "30 minutes ago")"
NOW="$(date '+%Y-%m-%d %H:%M:%S')"

# ---------------------------------------------------------------- collectors
# Each returns lines of "severity|title|detail". Empty output means nothing to
# report, which is the normal case and must stay silent.

collect_ssh_success() {
    journalctl -u ssh -u sshd --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "Accepted (password|publickey|keyboard-interactive)" \
      | sed -E 's/.*Accepted ([a-z-]+) for ([^ ]+) from ([0-9a-f.:]+).*/high|SSH login|user \2 from \3 via \1/' \
      | sort -u
}

collect_ssh_failures() {
    local n
    n=$(journalctl -u ssh -u sshd --since "$SINCE" --no-pager 2>/dev/null \
        | grep -cE "Failed password|Invalid user|Connection closed by authenticating")
    # Port 22 is closed to the world, so failures should be near zero. A burst
    # means either the firewall changed or something is inside the allowed range.
    [ "${n:-0}" -ge 10 ] && echo "medium|SSH failures|${n} failed attempts since ${SINCE}"
}

collect_sudo() {
    journalctl --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "sudo:.*COMMAND=" \
      | sed -E 's/.*sudo: *([^ ]+).*COMMAND=(.*)/medium|sudo|\1 ran \2/' \
      | cut -c1-300 | sort -u | head -10
}

collect_fail2ban() {
    journalctl -u fail2ban --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "\bBan\b" \
      | sed -E 's/.*\[([a-z-]+)\] Ban ([0-9a-f.:]+).*/medium|fail2ban ban|\2 banned by \1/' \
      | sort -u | head -10
}

collect_container() {
    local st restarts
    st=$(docker inspect minecraft-java --format '{{.State.Status}}' 2>/dev/null || echo missing)
    restarts=$(docker inspect minecraft-java --format '{{.RestartCount}}' 2>/dev/null || echo 0)
    [ "$st" != "running" ] && echo "high|Container not running|status=${st}"
    [ "${restarts:-0}" -gt 0 ] && echo "medium|Container restarts|RestartCount=${restarts}"
    return 0
}

collect_admin_files() {
    # auditd watches these (see server-audit.sh). A change to the whitelist or
    # ops file that nobody made deliberately is worth knowing about immediately.
    command -v ausearch >/dev/null 2>&1 || return 0
    ausearch --input-logs -ts recent -k mc-admin 2>/dev/null \
      | grep -oE 'name="[^"]+"' | sort -u | head -5 \
      | sed -E 's/name="(.*)"/medium|Admin file touched|\1/'
    return 0
}

collect_disk() {
    local pct
    pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -n "$pct" ] && [ "$pct" -ge 85 ] && echo "medium|Disk filling|root filesystem at ${pct}%"
    return 0
}

# ---------------------------------------------------------------- gather
EVENTS="$( { collect_ssh_success; collect_ssh_failures; collect_sudo;
             collect_fail2ban; collect_container; collect_admin_files;
             collect_disk; } 2>/dev/null | grep -v '^[[:space:]]*$' )"

# Record the checkpoint whether or not anything was found, so the next run does
# not re-report the same window. Written even on a failed post: repeating an
# alert forever is worse than missing one, because it destroys trust in all of
# them.
echo "$NOW" > "$STATE"

[ -z "$EVENTS" ] && { echo "no security events since $SINCE"; exit 0; }

# ---------------------------------------------------------------- report
HIGH=$(echo "$EVENTS" | grep -c '^high|' || true)
COLOUR=$([ "${HIGH:-0}" -gt 0 ] && echo 11027259 || echo 11106094)   # red : amber

FIELDS=$(echo "$EVENTS" | head -20 | awk -F'|' '
  { gsub(/"/,"\\\"",$2); gsub(/"/,"\\\"",$3);
    printf "%s{\"name\":\"%s\",\"value\":\"%s\",\"inline\":false}", (NR>1?",":""), $2, substr($3,1,900) }')

COUNT=$(echo "$EVENTS" | wc -l)
PAYLOAD=$(cat <<JSON
{"embeds":[{
  "title":"Security events on ${HOSTNAME_SHORT}",
  "description":"${COUNT} event(s) since ${SINCE}",
  "color":${COLOUR},
  "fields":[${FIELDS}],
  "footer":{"text":"EduCraft droplet security monitor"}
}]}
JSON
)

# --fail so a rejected post is a non-zero exit; -sS to stay quiet but still show
# real errors. The URL is passed on stdin-free argv only here, and curl does not
# echo it. Never add -v: it prints the full URL.
if printf '%s' "$PAYLOAD" | curl -sS --fail --max-time 25 \
       -H "Content-Type: application/json" -X POST -d @- "$DISCORD_WEBHOOK" >/dev/null 2>&1; then
    echo "posted ${COUNT} event(s)"
else
    # Deliberately does not print the webhook or the payload.
    echo "failed to post ${COUNT} event(s) to Discord" >&2
    exit 1
fi
