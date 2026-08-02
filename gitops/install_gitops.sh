#!/usr/bin/env bash
# Install the pull-based GitHub deploy loop on the droplet. Run as root:
#   bash /root/minecraft/gitops/install_gitops.sh
#
# ONE-TIME MIGRATION REQUIRED FIRST (done in the repo, not here):
# the container rewrites data/server.properties, whitelist.json, ops.json and
# banned-*.json at every boot. While those stay tracked, `git pull --ff-only`
# fails on the droplet every single time. Untrack them once:
#
#   git rm --cached data/server.properties data/whitelist.json data/ops.json \
#                   data/banned-players.json data/banned-ips.json
#   git rm -r --cached data/bluemap        # rewritten constantly by the live map
#   # add the same paths to .gitignore, commit, push
#
# Verified on the droplet 2026-08-01: data/bluemap/** alone leaves the worktree
# permanently dirty, which makes deploy.sh abort every run until it is untracked.
#
# After that, docker-compose.yml is the single source of truth for settings and
# rosters (WHITELIST / OPS env vars, with OVERRIDE_WHITELIST=true and
# OVERRIDE_OPS=true so the image SYNCHRONIZEs the json files from them).
# Adding a kid then becomes: edit compose, commit, push - the deploy applies it.
set -euo pipefail

REPO_DIR=/root/minecraft

[ -d "$REPO_DIR" ] || { echo "expected the repo at $REPO_DIR"; exit 1; }

echo "== verifying the repo is a clean, anonymous clone =="
cd "$REPO_DIR"
remote=$(git remote get-url origin)
case "$remote" in
    https://github.com/*) echo "remote OK: $remote" ;;
    *) echo "FAIL: remote must be an anonymous https clone, got: $remote"
       echo "an ssh remote or an embedded token would put a credential on this box"
       exit 1 ;;
esac
if git config --get credential.helper >/dev/null 2>&1 || [ -f /root/.git-credentials ]; then
    echo "FAIL: stored git credentials found; the droplet must hold none"
    exit 1
fi

echo "== installing units =="
chmod +x "$REPO_DIR/gitops/deploy.sh"
install -m 644 "$REPO_DIR/gitops/minecraft-deploy.service" /etc/systemd/system/
install -m 644 "$REPO_DIR/gitops/minecraft-deploy.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now minecraft-deploy.timer

echo "== status =="
systemctl list-timers minecraft-deploy.timer --no-pager
echo
echo "Deploys now run automatically within ~5 minutes of a push to main."
echo "Watch one:      journalctl -u minecraft-deploy.service -f"
echo "Force one now:  systemctl start minecraft-deploy.service"
echo "Pause deploys:  systemctl stop minecraft-deploy.timer"
