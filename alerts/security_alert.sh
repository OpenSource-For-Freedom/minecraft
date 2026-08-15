#!/usr/bin/env bash
# Post NEW security events from this droplet to Discord.
#
# Installed at /usr/local/bin/mc-security-alert, run by a systemd timer every
# 15 minutes. See alerts/install_alerts.sh.
#
# DESIGN GOAL: ZERO FALSE POSITIVES.
#
# An alert channel is only useful while a message in it means "look at this".
# The first version of this script failed that badly and is worth recording so
# the mistakes are not repeated:
#   - it alerted on EVERY sudo command, so ordinary admin work buried the signal
#   - it alerted on docker RestartCount > 0, which is CUMULATIVE, so after any
#     deploy it fired on every single run forever until the container was
#     recreated. A permanent alert is the same as no alert.
#   - it alerted on whitelist edits, which are routine and expected
#
# What is watched now is deliberately narrow: things that are rare, and that a
# person would want to know about within minutes. Anything that happens during
# normal operation is NOT here, on purpose.
#
# THREAT MODEL for the credential this holds.
#
# The webhook lives in /etc/minecraft-alerts.env, root:root 0600, outside the
# git repo and outside the container. The game runs as uid 1000 with a
# read-only rootfs and all capabilities dropped, so compromising Minecraft does
# not reach it. Stealing it lets an attacker post to a private Discord channel
# and spam it: annoying, not dangerous. It grants no route back into the
# droplet, because a webhook is write-only and one-directional. That asymmetry
# is why storing it here beats letting anything reach IN to collect events.
#
# Rotate by deleting the webhook in Discord and re-running install_alerts.sh.
set -uo pipefail

ENV_FILE="/etc/minecraft-alerts.env"
STATE_DIR="/var/lib/mc-alerts"
STATE="$STATE_DIR/last-run"
CONTAINER_STATE="$STATE_DIR/last-container-start"
HOST_SHORT="$(hostname -s 2>/dev/null || echo droplet)"

# Accounts expected to log in over SSH. A login by ANY other name is reported
# as high severity, because on this box that is not routine.
KNOWN_USERS="${KNOWN_SSH_USERS:-edueq9r3eiky wali root}"

[ -r "$ENV_FILE" ] || { echo "no $ENV_FILE; run install_alerts.sh" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${DISCORD_WEBHOOK:-}" ] || { echo "DISCORD_WEBHOOK unset in $ENV_FILE" >&2; exit 1; }

mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
SINCE="$(cat "$STATE" 2>/dev/null || echo "30 minutes ago")"
NOW="$(date '+%Y-%m-%d %H:%M:%S')"

# Each collector emits "severity|title|detail" lines. Empty output is the
# normal, healthy case and must stay silent.

# --- SSH logins: every one, by explicit choice. Only two people should ever
# --- log in here, so each login is genuinely worth seeing.
collect_ssh_success() {
    journalctl -u ssh -u sshd --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "Accepted (password|publickey|keyboard-interactive)" \
      | while read -r line; do
            u=$(echo "$line" | sed -nE 's/.*Accepted [a-z-]+ for ([^ ]+) from .*/\1/p')
            ip=$(echo "$line" | sed -nE 's/.*from ([0-9a-fA-F.:]+) port.*/\1/p')
            m=$(echo "$line" | sed -nE 's/.*Accepted ([a-z-]+) for .*/\1/p')
            [ -z "$u" ] && continue
            # An unrecognised username is a different class of event entirely.
            if echo " $KNOWN_USERS " | grep -q " $u "; then
                echo "medium|SSH login|${u} from ${ip} via ${m}"
            else
                echo "high|SSH login by UNKNOWN user|${u} from ${ip} via ${m}"
            fi
        done | sort -u | head -10
}

# --- Failed auth: port 22 is closed to everything but DigitalOcean console
# --- ranges, so genuine failures should be ~0. A burst means the firewall
# --- changed or something is inside the allowed range.
collect_ssh_failures() {
    local n
    n=$(journalctl -u ssh -u sshd --since "$SINCE" --no-pager 2>/dev/null \
        | grep -cE "Failed password|Invalid user|Connection closed by authenticating")
    [ "${n:-0}" -ge 10 ] && echo "high|SSH failure burst|${n} failed attempts since ${SINCE}"
    return 0
}

# --- sudo: SENSITIVE commands only. Routine docker/journal/diagnostic work is
# --- deliberately ignored; it is the single biggest source of noise and it
# --- tells you nothing you did not already know.
collect_sudo_sensitive() {
    journalctl --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "sudo:.*COMMAND=" \
      | grep -EI "useradd|usermod|userdel|groupadd|passwd|visudo|/etc/sudoers|authorized_keys|sshd_config|iptables|ufw|systemctl (enable|disable|mask)|chattr|/etc/shadow|/etc/passwd" \
      | sed -E 's/.*sudo: *([^ ]+).*COMMAND=(.*)/high|Sensitive sudo|\1 ran \2/' \
      | cut -c1-300 | sort -u | head -6
    return 0
}

collect_fail2ban() {
    journalctl -u fail2ban --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "\bBan\b" \
      | sed -E 's/.*\[([a-z-]+)\] Ban ([0-9a-fA-F.:]+).*/medium|fail2ban ban|\2 banned by \1/' \
      | sort -u | head -10
    return 0
}

# --- Container: compare the START TIME against the last observed one.
# --- RestartCount is cumulative and never resets, so alerting on it produced a
# --- permanent alert after the first restart. Comparing StartedAt reports each
# --- restart exactly once, which is what was actually wanted.
collect_container() {
    local st started last
    st=$(docker inspect minecraft-java --format '{{.State.Status}}' 2>/dev/null || echo missing)
    started=$(docker inspect minecraft-java --format '{{.State.StartedAt}}' 2>/dev/null || echo unknown)
    last=$(cat "$CONTAINER_STATE" 2>/dev/null || echo "")

    [ "$st" != "running" ] && echo "high|Minecraft container is ${st}|expected running"
    if [ -n "$last" ] && [ "$started" != "$last" ] && [ "$started" != "unknown" ]; then
        echo "medium|Minecraft restarted|now up since ${started}"
    fi
    [ "$started" != "unknown" ] && echo "$started" > "$CONTAINER_STATE"
    return 0
}

# --- Files that matter. Whitelist edits are deliberately NOT here: adding a
# --- player is routine. ops.json IS here, because granting operator is
# --- privilege escalation on the game server.
collect_sensitive_files() {
    local f
    for f in /etc/sudoers /etc/passwd /etc/shadow /root/.ssh/authorized_keys \
             /etc/ssh/sshd_config /var/lib/docker/volumes; do
        :
    done
    # ops.json lives in the bind-mounted data dir
    if [ -f /root/minecraft/data/ops.json ] || [ -f /opt/minecraft/data/ops.json ]; then
        local ops
        ops=$(find /root/minecraft/data/ops.json /opt/minecraft/data/ops.json -maxdepth 0 2>/dev/null | head -1)
        if [ -n "$ops" ] && [ -n "$(find "$ops" -newermt "$SINCE" 2>/dev/null)" ]; then
            echo "high|Operator list changed|$(basename "$ops") modified; verify who was granted op"
        fi
    fi
    for f in /etc/sudoers /etc/ssh/sshd_config /root/.ssh/authorized_keys; do
        [ -e "$f" ] && [ -n "$(find "$f" -newermt "$SINCE" 2>/dev/null)" ] \
            && echo "high|Sensitive file changed|${f}"
    done
    return 0
}

collect_new_users() {
    journalctl --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "new user: name=|useradd\[[0-9]+\]: new user" \
      | sed -E 's/.*new user: name=([^,]+).*/high|New user account|\1 created/' \
      | sort -u | head -5
    return 0
}

collect_disk() {
    local pct
    pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -n "$pct" ] && [ "$pct" -ge 90 ] && echo "high|Disk nearly full|root filesystem at ${pct}%"
    return 0
}

EVENTS="$( { collect_ssh_success; collect_ssh_failures; collect_sudo_sensitive;
             collect_fail2ban; collect_container; collect_sensitive_files;
             collect_new_users; collect_disk; } 2>/dev/null \
           | grep -v '^[[:space:]]*$' )"

# Advance the checkpoint whether or not anything was found, and even if the post
# fails. Repeating an alert forever is worse than missing one: it destroys trust
# in every other alert in the channel.
echo "$NOW" > "$STATE"

[ -z "$EVENTS" ] && { echo "no security events since $SINCE"; exit 0; }

HIGH=$(echo "$EVENTS" | grep -c '^high|' || true)
COLOUR=$([ "${HIGH:-0}" -gt 0 ] && echo 11027259 || echo 11106094)   # red : amber

FIELDS=$(echo "$EVENTS" | head -20 | awk -F'|' '
  { gsub(/"/,"\\\"",$2); gsub(/"/,"\\\"",$3); gsub(/\\/,"\\\\",$3);
    printf "%s{\"name\":\"%s\",\"value\":\"%s\",\"inline\":false}", (NR>1?",":""), $2, substr($3,1,900) }')

COUNT=$(echo "$EVENTS" | wc -l)
PAYLOAD=$(cat <<JSON
{"embeds":[{
  "title":"Security events on ${HOST_SHORT}",
  "description":"${COUNT} event(s) since ${SINCE}",
  "color":${COLOUR},
  "fields":[${FIELDS}],
  "footer":{"text":"EduCraft droplet security monitor"}
}]}
JSON
)

# Never add -v to curl: it prints the full URL, which is the credential.
if printf '%s' "$PAYLOAD" | curl -sS --fail --max-time 25 \
       -H "Content-Type: application/json" -X POST -d @- "$DISCORD_WEBHOOK" >/dev/null 2>&1; then
    echo "posted ${COUNT} event(s)"
else
    echo "failed to post ${COUNT} event(s) to Discord" >&2
    exit 1
fi
