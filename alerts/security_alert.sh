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
# ZERO FALSE NEGATIVES MATTER JUST AS MUCH. The second version chased quiet so
# hard that it broke the other way, and those bugs are the reason for this one:
#   - collect_sensitive_files listed /etc/passwd, /etc/shadow and the docker
#     volume root in a for-loop whose entire body was `:`. It read as if six
#     paths were watched while three were, so a change to /etc/shadow was
#     silently never reported. An invisible no-op is the worst kind of gap:
#     the code documents a control that does not exist.
#   - the JSON escaper replaced quotes BEFORE backslashes, so escaping its own
#     output turned \" into \\" and produced invalid JSON. Discord rejects the
#     post, curl --fail returns non-zero, and the whole batch was dropped.
#   - three collectors ran `sed` without -n, so any line that matched the grep
#     but not the sed pattern was emitted VERBATIM into the event stream. A raw
#     journal line has no severity|title|detail shape and contains quotes, so
#     it corrupted the payload and took the whole batch down with it.
#   - the checkpoint advanced before the post, so a failed post lost its events
#     permanently. That turned any of the bugs above into silent data loss.
#   - if this script stopped running at all, the channel simply went quiet, and
#     quiet is exactly what healthy looks like. There was no way to tell the
#     difference. That is the same blind spot that let the playtime limiter be
#     documented as dead for a month while it ran.
#
# So: events survive a failed post and are retried, and a heartbeat proves the
# monitor is alive even when it has nothing to say.
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
# That file is SOURCED as root, so whoever can write it gets root code
# execution. check_env_file is what makes that trade acceptable.
#
# NOTHING IDENTIFYING GOES IN THIS FILE. This repo is public. The list of
# accounts allowed to log in used to be a hardcoded default here, which
# published the deliberately non-obvious name that sshd's AllowUsers permits on
# a box under constant brute-force. It now comes from the env file only, and
# install_alerts.sh reads it from sshd's own config so nobody has to type it.
#
# Rotate the webhook by deleting it in Discord and re-running install_alerts.sh.
set -uo pipefail

ENV_FILE="/etc/minecraft-alerts.env"
STATE_DIR="/var/lib/mc-alerts"
STATE="$STATE_DIR/last-run"
CONTAINER_STATE="$STATE_DIR/last-container-start"
PENDING="$STATE_DIR/pending"
PENDING_TRIES="$STATE_DIR/pending-tries"
HEARTBEAT_STATE="$STATE_DIR/last-heartbeat"

# Accounts expected to log in over SSH, space separated. Set by
# install_alerts.sh in $ENV_FILE. Deliberately EMPTY here: see the note above.
# Empty is fail-safe, not fail-open - every login is then unrecognised and
# reported high, which is noisy but never silent.
KNOWN_USERS=""

# A failed post is retried on the next run. Give up after this many runs (8 x
# 15min = 2h) so a permanently broken webhook cannot re-post the same backlog
# forever, which is the "permanent alert equals no alert" trap again.
MAX_PENDING_TRIES="${MAX_PENDING_TRIES:-8}"
MAX_PENDING_LINES=200

# Say "still watching" this often when there is nothing to report, so silence
# in the channel means healthy rather than dead. 0 disables.
HEARTBEAT_HOURS="${HEARTBEAT_HOURS:-24}"

# Discord caps an embed field value at 1024 characters and counts the ESCAPED
# string, so truncate before escaping and leave room for the worst case where
# every character doubles.
MAX_DETAIL=480
MAX_TITLE=200

# --- JSON. Hand-rolled because jq is not installed and adding a dependency to
# --- the thing that reports the box is unhealthy is the wrong direction.
# --- ORDER IS LOAD-BEARING: backslashes first, then quotes. The reverse escapes
# --- the escapes and emits invalid JSON.
json_escape() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\t'/ }
    s=${s//$'\r'/ }
    s=${s//$'\n'/ }
    # Any remaining C0 control character is illegal inside a JSON string.
    printf '%s' "$s" | tr -d '\000-\037'
}

# Reads "severity|title|detail" lines on stdin, emits the embed fields array
# body. A line without a title is dropped rather than trusted: that is the
# shape a stray raw journal line arrives in.
#
# High-severity fields are marked in the title. The embed colour only says
# "at least one of these is high", which is useless in a batch of six.
build_fields() {
    local first=1 sev title detail mark
    while IFS='|' read -r sev title detail; do
        [ -n "${title:-}" ] || continue
        [ "$first" -eq 1 ] || printf ','
        first=0
        mark=""
        [ "$sev" = "high" ] && mark="[!] "
        printf '{"name":"%s%s","value":"%s","inline":false}' \
            "$mark" \
            "$(json_escape "${title:0:$MAX_TITLE}")" \
            "$(json_escape "${detail:0:$MAX_DETAIL}")"
    done
}

build_payload() {
    local events=$1 host=$2 since=$3 count high colour fields
    count=$(printf '%s\n' "$events" | grep -c . || true)
    high=$(printf '%s\n' "$events" | grep -c '^high|' || true)
    colour=$([ "${high:-0}" -gt 0 ] && echo 11027259 || echo 11106094)   # red : amber
    fields=$(printf '%s\n' "$events" | head -n 20 | build_fields)
    printf '{"embeds":[{"title":"Security events on %s","description":"%s event(s) since %s","color":%s,"fields":[%s],"footer":{"text":"EduCraft droplet security monitor"}}]}' \
        "$(json_escape "$host")" "$count" "$(json_escape "$since")" "$colour" "$fields"
}

# --- The env file is sourced as root. Refuse it unless root owns it and nobody
# --- else can write it, otherwise this script is a privilege escalation.
check_env_file() {
    local owner mode
    [ -r "$ENV_FILE" ] || { echo "no $ENV_FILE; run install_alerts.sh" >&2; return 1; }
    owner=$(stat -c '%u' "$ENV_FILE" 2>/dev/null || echo unknown)
    mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo unknown)
    [ "$owner" = "0" ] \
        || { echo "refusing to source $ENV_FILE: owner uid $owner, expected 0" >&2; return 1; }
    case "$mode" in
        600|400) ;;
        *) echo "refusing to source $ENV_FILE: mode $mode, expected 600" >&2; return 1 ;;
    esac
}

classify_login() {
    # root cannot log in over SSH on this box: PermitRootLogin is
    # prohibit-password and AllowUsers permits one non-root account. An
    # ACCEPTED root login therefore means that config was changed or bypassed,
    # which is never routine no matter what KNOWN_USERS says.
    case "$1" in
        root) echo high; return 0 ;;
    esac
    [ -n "$KNOWN_USERS" ] || { echo high; return 0; }
    # Quoted so a username containing glob characters is matched literally.
    case " $KNOWN_USERS " in
        *" $1 "*) echo medium ;;
        *) echo high ;;
    esac
}

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
            if [ "$(classify_login "$u")" = "medium" ]; then
                echo "medium|SSH login|${u} from ${ip} via ${m}"
            else
                echo "high|SSH login by unexpected user|${u} from ${ip} via ${m}"
            fi
        done | sort -u | head -n 10
    return 0
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
# --- sed -n plus p: a line the grep caught but this pattern cannot parse is
# --- DROPPED, never passed through raw.
collect_sudo_sensitive() {
    journalctl --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "sudo:.*COMMAND=" \
      | grep -EI "useradd|usermod|userdel|groupadd|passwd|visudo|/etc/sudoers|authorized_keys|sshd_config|iptables|ufw|systemctl (enable|disable|mask)|chattr|/etc/shadow|/etc/passwd" \
      | sed -nE 's/.*sudo: *([^ ]+).*COMMAND=(.*)/high|Sensitive sudo|\1 ran \2/p' \
      | cut -c1-300 | sort -u | head -n 6
    return 0
}

collect_fail2ban() {
    journalctl -u fail2ban --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "\bBan\b" \
      | sed -nE 's/.*\[([a-zA-Z0-9_-]+)\] Ban ([0-9a-fA-F.:]+).*/medium|fail2ban ban|\2 banned by \1/p' \
      | sort -u | head -n 10
    return 0
}

# --- The controls this box depends on. If fail2ban dies, port 22 is naked
# --- against the brute-force it takes all day and the channel would otherwise
# --- stay quiet about it.
collect_control_health() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl is-active --quiet fail2ban 2>/dev/null \
            || echo "high|fail2ban is not running|brute-force protection on port 22 is off"
    fi
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
# --- The sshd DROP-IN directory is watched as well as sshd_config, because the
# --- hardening this box relies on lives in sshd_config.d/10-hardening.conf and
# --- undoing it never touches sshd_config itself.
# --- /home/*/.ssh/authorized_keys matters MORE than root's here: root cannot
# --- log in over SSH, so the sudo-capable account's keys are the real path in.
sensitive_paths() {
    local p
    for p in /etc/sudoers /etc/passwd /etc/shadow /etc/ssh/sshd_config \
             /root/.ssh/authorized_keys \
             /etc/sudoers.d/* /etc/ssh/sshd_config.d/*.conf \
             /home/*/.ssh/authorized_keys; do
        # An unmatched glob arrives as its own literal pattern; -e drops it.
        [ -e "$p" ] && printf '%s\n' "$p"
    done
    return 0
}

collect_sensitive_files() {
    local f ops
    for ops in /root/minecraft/data/ops.json /opt/minecraft/data/ops.json; do
        [ -f "$ops" ] || continue
        if [ -n "$(find "$ops" -newermt "$SINCE" 2>/dev/null)" ]; then
            echo "high|Operator list changed|${ops} modified; verify who was granted op"
        fi
        break
    done
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        [ -n "$(find "$f" -newermt "$SINCE" 2>/dev/null)" ] \
            && echo "high|Sensitive file changed|${f}"
    done < <(sensitive_paths)
    return 0
}

collect_new_users() {
    journalctl --since "$SINCE" --no-pager 2>/dev/null \
      | grep -E "new user: name=|useradd\[[0-9]+\]: new user" \
      | sed -nE 's/.*new user: name=([^,]+).*/high|New user account|\1 created/p' \
      | sort -u | head -n 5
    return 0
}

collect_disk() {
    local pct
    pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -n "$pct" ] && [ "$pct" -ge 90 ] && echo "high|Disk nearly full|root filesystem at ${pct}%"
    return 0
}

post_to_discord() {
    # Never add -v to curl: it prints the full URL, which is the credential.
    printf '%s' "$1" | curl -sS --fail --max-time 25 \
        -H "Content-Type: application/json" -X POST -d @- "$DISCORD_WEBHOOK" >/dev/null 2>&1
}

# Post, and decide what happens to the events if that fails. Separated from
# main so a test can stub post_to_discord and point the spool at a temp file:
# "a failed post must not lose events" is the one behaviour here that cannot be
# verified by reading the source, and it is the one that silently broke.
dispatch() {
    local events=$1 host=$2 since=$3 count tries
    count=$(printf '%s\n' "$events" | grep -c . || true)

    if post_to_discord "$(build_payload "$events" "$host" "$since")"; then
        rm -f "$PENDING" "$PENDING_TRIES"
        date +%s > "$HEARTBEAT_STATE"
        echo "posted ${count} event(s)"
        return 0
    fi

    tries=$(cat "$PENDING_TRIES" 2>/dev/null || echo 0)
    case "$tries" in ''|*[!0-9]*) tries=0 ;; esac
    tries=$(( tries + 1 ))
    if [ "$tries" -ge "$MAX_PENDING_TRIES" ]; then
        # Giving up is a decision, so make it loud in the journal, which is
        # persistent on this box. Keeping them would re-post the same backlog
        # every 15 minutes forever, which is the trap at the top of this file.
        echo "dropping ${count} event(s) after ${tries} failed posts; they remain in the journal" >&2
        printf '%s\n' "$events" >&2
        rm -f "$PENDING" "$PENDING_TRIES"
        return 1
    fi
    printf '%s\n' "$events" | tail -n "$MAX_PENDING_LINES" > "$PENDING"
    echo "$tries" > "$PENDING_TRIES"
    echo "failed to post ${count} event(s); retained for retry (attempt ${tries}/${MAX_PENDING_TRIES})" >&2
    return 1
}

heartbeat_due() {
    local last now hours
    hours=$HEARTBEAT_HOURS
    case "$hours" in ''|*[!0-9]*) return 1 ;; esac
    [ "$hours" -gt 0 ] || return 1
    last=$(cat "$HEARTBEAT_STATE" 2>/dev/null || echo 0)
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    now=$(date +%s)
    [ $(( now - last )) -ge $(( hours * 3600 )) ]
}

main() {
    check_env_file || return 1
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    [ -n "${DISCORD_WEBHOOK:-}" ] || { echo "DISCORD_WEBHOOK unset in $ENV_FILE" >&2; return 1; }
    KNOWN_USERS="${KNOWN_SSH_USERS:-}"

    mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
    SINCE="$(cat "$STATE" 2>/dev/null || echo "30 minutes ago")"
    local now_stamp host events pending
    now_stamp="$(date '+%Y-%m-%d %H:%M:%S')"
    host="$(hostname -s 2>/dev/null || echo droplet)"

    events="$( { collect_ssh_success; collect_ssh_failures; collect_sudo_sensitive;
                 collect_fail2ban; collect_control_health; collect_container;
                 collect_sensitive_files; collect_new_users; collect_disk; } 2>/dev/null \
               | grep -v '^[[:space:]]*$' )"

    # An empty account list means logins cannot be recognised. Say so, but on
    # the heartbeat clock: a misconfiguration that re-posts every 15 minutes
    # forever is the "permanent alert equals no alert" trap from the top of
    # this file. Meanwhile every login still reports high, so nothing is missed.
    if [ -z "$KNOWN_USERS" ] && heartbeat_due; then
        events="high|Alerting is misconfigured|KNOWN_SSH_USERS is unset in ${ENV_FILE}; every SSH login will report as unexpected until install_alerts.sh is re-run
${events}"
    fi

    # Advance the checkpoint whether or not anything was found. Re-reading the
    # same journal window would duplicate every event; events that fail to post
    # are preserved in $PENDING instead, which is what makes that safe.
    echo "$now_stamp" > "$STATE"

    pending=""
    [ -s "$PENDING" ] && pending="$(cat "$PENDING")"
    if [ -n "$pending" ]; then
        events="$(printf '%s\n%s' "$pending" "$events" | grep -v '^[[:space:]]*$')"
    fi

    if [ -z "$events" ]; then
        if heartbeat_due; then
            if post_to_discord "$(build_payload "medium|Monitor is alive|no security events in the last ${HEARTBEAT_HOURS}h; this message exists so silence cannot be mistaken for health" "$host" "$SINCE")"; then
                date +%s > "$HEARTBEAT_STATE"
                echo "posted heartbeat"
            else
                echo "failed to post heartbeat" >&2
            fi
            return 0
        fi
        echo "no security events since $SINCE"
        return 0
    fi

    dispatch "$events" "$host" "$SINCE"
}

# Sourced with MC_ALERT_LIB_ONLY=1 by tests/test_security_alerts.py, which
# exercises the escaping and classification directly. Unset in production.
if [ "${MC_ALERT_LIB_ONLY:-0}" != "1" ]; then
    main "$@"
fi
