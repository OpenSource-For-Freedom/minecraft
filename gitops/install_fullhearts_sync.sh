#!/usr/bin/env bash
# Install the FullHearts whitelist sync on the droplet. Run as root:
#   bash /root/minecraft/gitops/install_fullhearts_sync.sh
#
# Starts in dry-run: it only reports what it WOULD add or remove, and the
# FullHearts admin page shows that report. Switch to live after checking it:
#   sed -i 's/^SYNC_MODE=.*/SYNC_MODE=apply/' /etc/educraft-sync.env
#
# The token is prompted for, never taken as an argument, because arguments
# land in shell history and /proc/<pid>/cmdline. It can only read one realm's
# list of website-managed usernames and post a report back.
set -euo pipefail

ENV_FILE=/etc/educraft-sync.env
REPO_DIR=/root/minecraft

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -r "$REPO_DIR/gitops/fullhearts_sync.py" ] || { echo "expected the repo at $REPO_DIR" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

if grep -Eq '^[[:space:]]*OVERRIDE_WHITELIST' "$REPO_DIR/docker-compose.yml" 2>/dev/null; then
    echo "docker-compose.yml sets OVERRIDE_WHITELIST; that would wipe synced players on every deploy. Remove it first." >&2
    exit 1
fi

if [ -r "$ENV_FILE" ] && grep -q '^FULLHEARTS_SYNC_TOKEN=' "$ENV_FILE"; then
    echo "  token already configured in $ENV_FILE (leaving it alone)"
else
    echo "  Paste the sync token from the FullHearts admin page (Set up sync). It will not be echoed."
    printf '  token: '
    read -r -s TOKEN
    echo
    case "$TOKEN" in
        edusync_*) ;;
        *) echo "  that does not look like a FullHearts sync token" >&2; exit 1 ;;
    esac
    umask 077
    {
        printf 'FULLHEARTS_SYNC_URL=https://fullhearts.app\n'
        printf 'FULLHEARTS_SYNC_TOKEN=%s\n' "$TOKEN"
        printf 'SYNC_MODE=dryrun\n'
        printf 'MAX_REMOVALS_PER_RUN=2\n'
        printf 'REMOVAL_ALARM=5\n'
    } > "$ENV_FILE"
    unset TOKEN
    echo "  wrote $ENV_FILE"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

install -m 644 "$REPO_DIR/gitops/fullhearts-sync.service" /etc/systemd/system/
install -m 644 "$REPO_DIR/gitops/fullhearts-sync.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fullhearts-sync.timer

echo
echo "Installed in $(sed -n 's/^SYNC_MODE=//p' "$ENV_FILE") mode."
echo "Run once now:   systemctl start fullhearts-sync.service"
echo "Watch it:       journalctl -u fullhearts-sync.service -f"
echo "Pause it:       systemctl stop fullhearts-sync.timer"
echo "Its own record: /var/lib/educraft-sync/ledger.json (players it added; nobody else is ever touched)"
