#!/usr/bin/env bash
# Install droplet-side security alerting to Discord. Run as root ON the droplet.
#
#   sudo ./alerts/install_alerts.sh
#
# Prompts for the webhook rather than taking it as an argument, because an
# argument lands in shell history and in /proc/<pid>/cmdline where any local
# user can read it while the command runs.
#
# The webhook is written to /etc/minecraft-alerts.env as root:root 0600, which
# is outside the git repo and outside the container. It is never committed.
set -euo pipefail

ENV_FILE="/etc/minecraft-alerts.env"
BIN="/usr/local/bin/mc-security-alert"
SRC="$(cd "$(dirname "$0")" && pwd)/security_alert.sh"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -r "$SRC" ] || { echo "cannot read $SRC" >&2; exit 1; }

echo "=== EduCraft droplet security alerts ==="

if [ -r "$ENV_FILE" ] && grep -q '^DISCORD_WEBHOOK=' "$ENV_FILE"; then
    echo "  webhook already configured in $ENV_FILE (leaving it alone)"
else
    echo
    echo "  Paste the Discord webhook URL. It will not be echoed."
    echo "  Discord: Server Settings > Integrations > Webhooks > Copy URL"
    printf '  webhook: '
    read -r -s WEBHOOK
    echo
    case "$WEBHOOK" in
        https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*) ;;
        *) echo "  that does not look like a Discord webhook URL" >&2; exit 1 ;;
    esac
    umask 077
    printf 'DISCORD_WEBHOOK=%s\n' "$WEBHOOK" > "$ENV_FILE"
    unset WEBHOOK
    echo "  wrote $ENV_FILE"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "  permissions: $(stat -c '%U:%G %a' "$ENV_FILE")"

# The list of accounts allowed to log in must NOT live in the repo: the repo is
# public and the account name is deliberately non-obvious. Read it from sshd's
# own effective config, which is the authority on who may log in, so nobody has
# to type it and it stays correct if AllowUsers changes.
if grep -q '^KNOWN_SSH_USERS=' "$ENV_FILE"; then
    echo "  KNOWN_SSH_USERS already set in $ENV_FILE (leaving it alone)"
else
    ALLOWED="$(sshd -T 2>/dev/null | sed -nE 's/^allowusers (.*)/\1/p' | tr ',' ' ' | tr -s ' ')"
    if [ -z "$ALLOWED" ]; then
        ALLOWED="$(cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null \
                   | sed -nE 's/^[[:space:]]*AllowUsers[[:space:]]+(.*)/\1/p' \
                   | tr ',' ' ' | tr -s ' ' | tr '\n' ' ')"
    fi
    if [ -z "$ALLOWED" ]; then
        echo
        echo "  sshd declares no AllowUsers, so the expected accounts cannot be derived."
        echo "  Type them space separated. Leave blank to report EVERY login as unexpected."
        printf '  accounts: '
        read -r ALLOWED
    fi
    # Trim, and never record root: root cannot log in over SSH here, so an
    # accepted root login is an incident regardless of this list.
    ALLOWED="$(printf '%s' "$ALLOWED" | tr ' ' '\n' | grep -v '^root$' | grep -v '^$' | sort -u | tr '\n' ' ' | sed -E 's/ +$//')"
    umask 077
    printf 'KNOWN_SSH_USERS=%s\n' "$ALLOWED" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if [ -n "$ALLOWED" ]; then
        echo "  recorded $(printf '%s' "$ALLOWED" | wc -w) expected SSH account(s) in $ENV_FILE (not echoed)"
    else
        echo "  WARNING: no expected accounts recorded; every SSH login will alert"
    fi
fi

install -m 0755 -o root -g root "$SRC" "$BIN"
echo "  installed $BIN"

cat > /etc/systemd/system/mc-security-alert.service <<'UNIT'
[Unit]
Description=Report droplet security events to Discord
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mc-security-alert
# The unit reads journald, auditd and docker, so it needs root. It is hardened
# in every direction that does not break those.
NoNewPrivileges=true
PrivateTmp=true
# read-only, NOT true. ProtectHome=true hides /home entirely, which would make
# the check on /home/*/.ssh/authorized_keys find nothing and report nothing -
# a control that looks present and is not. Those keys are the real way into
# this box, because root cannot log in over SSH.
ProtectHome=read-only
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
# The webhook must never reach the journal. Output is intentionally minimal and
# the script never prints it, but this is the belt to that braces.
StandardOutput=journal
StandardError=journal
UNIT

cat > /etc/systemd/system/mc-security-alert.timer <<'UNIT'
[Unit]
Description=Check for droplet security events every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
# Spread the load so every timer on the box does not fire on the same second.
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now mc-security-alert.timer
echo "  timer enabled:"
systemctl list-timers mc-security-alert.timer --no-pager 2>/dev/null | head -3

echo
echo "  running once now to prove the wiring..."
if "$BIN"; then
    echo "  OK"
else
    echo "  the run reported a problem; check: journalctl -u mc-security-alert -n 20"
fi

echo
echo "  Rotate the webhook any time by deleting it in Discord and re-running this."
echo "  Check state:   systemctl status mc-security-alert.timer"
echo "  Recent runs:   journalctl -u mc-security-alert -n 40"
