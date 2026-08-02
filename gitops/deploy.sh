#!/usr/bin/env bash
# Pull-based deploy: the droplet asks GitHub for changes, GitHub never reaches in.
# No inbound port, no credential on this box - the repo is public and cloned
# anonymously over HTTPS. Run by minecraft-deploy.timer; safe to run by hand.
#
# Flow: fetch -> nothing new? exit -> CI gate -> backup -> warn players -> pull
#       -> rebuild -> health check -> roll back automatically if the new
#       revision is broken.
set -euo pipefail

REPO_DIR=${REPO_DIR:-/root/minecraft}
BRANCH=${BRANCH:-main}
CONTAINER=minecraft-java
BACKUP_DIR=${BACKUP_DIR:-/root/backups}
KEEP_BACKUPS=7
HEALTH_TIMEOUT=300   # seconds to wait for the server to answer after a rebuild

log() { echo "$(date -Is) $*"; }
rcon() { docker exec -i "$CONTAINER" rcon-cli "$@" 2>/dev/null || true; }

# Compose v2 ("docker compose") and the standalone v1 binary ("docker-compose")
# are both found in the wild on DigitalOcean images, and a droplet with only v1
# fails here with a confusing "unknown shorthand flag: 'd'". Detect rather than
# assume, and fail loudly if neither exists instead of part-way through a deploy.
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    echo "ABORT: neither 'docker compose' nor 'docker-compose' is available" >&2
    exit 1
fi

cd "$REPO_DIR"

# A tracked file modified on disk means someone edited on the box, or runtime
# state is still tracked (see the migration note in install_gitops.sh). Refuse
# rather than discard: throwing away an unknown local edit is worse than
# skipping a deploy, and a rotated rcon password lives in exactly such a file.
if ! git diff --quiet HEAD -- ; then
    log "ABORT: tracked files modified locally; not deploying"
    git status --porcelain | head -20
    exit 1
fi

git fetch --quiet origin "$BRANCH"
OLD_SHA=$(git rev-parse HEAD)
NEW_SHA=$(git rev-parse "origin/$BRANCH")

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
    exit 0    # nothing to do; stay quiet so the timer does not spam the journal
fi

log "new revision ${OLD_SHA:0:8} -> ${NEW_SHA:0:8}"

# CI gate: only run code that GitHub Actions already validated. The repo is
# public, so this needs no token - and no token is exactly the point: GitHub
# never gets a key to this box, and this box holds no credential for GitHub.
# A commit whose checks failed, or has not finished, is simply not deployed yet.
if [ "${REQUIRE_CI:-true}" = "true" ]; then
    api="https://api.github.com/repos/${GH_REPO:-OpenSource-For-Freedom/minecraft}/commits/${NEW_SHA}/check-runs"
    runs=$(curl -fsSL --max-time 20 -H "Accept: application/vnd.github+json" "$api" || echo "")
    if [ -z "$runs" ]; then
        log "SKIP: cannot reach the GitHub checks API; will retry next tick"
        exit 0
    fi
    total=$(echo "$runs" | grep -o '"total_count"[^,]*' | head -1 | grep -o '[0-9]*$')
    completed=$(echo "$runs" | grep -c '"status": *"completed"' || true)
    succeeded=$(echo "$runs" | grep -c '"conclusion": *"success"' || true)
    if [ "${total:-0}" -eq 0 ] || [ "$completed" -ne "${total:-0}" ]; then
        log "SKIP: checks not finished for ${NEW_SHA:0:8} (${completed}/${total:-0}); will retry next tick"
        exit 0
    fi
    if [ "$succeeded" -ne "$total" ]; then
        log "REFUSING ${NEW_SHA:0:8}: CI did not pass (${succeeded}/${total} green)"
        exit 1
    fi
    log "CI green (${succeeded}/${total}) for ${NEW_SHA:0:8}"
fi

# Back up before touching a running world. Restores are the real safety net;
# PrismProtect only rolls back blocks, not a corrupted save.
mkdir -p "$BACKUP_DIR"
if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    rcon save-all
    sleep 5
fi
tar czf "$BACKUP_DIR/pre-deploy-$(date +%F-%H%M%S).tgz" -C "$REPO_DIR/data" \
    world ops.json whitelist.json server.properties 2>/dev/null || \
    log "warning: backup incomplete (first deploy?)"
find "$BACKUP_DIR" -maxdepth 1 -name 'pre-deploy-*.tgz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$((KEEP_BACKUPS+1)) | cut -d' ' -f2- | xargs -r rm --

# Kids deserve a warning before they get disconnected.
rcon say "Server updating. Back in about a minute."
sleep 5

git pull --ff-only origin "$BRANCH"

# Git writes as root; the container runs as uid 1000 and boot-loops with
# AccessDeniedException if it cannot write its own data files.
chown -R 1000:1000 data

$COMPOSE up -d --build

# Health gate: a container that is "running" can still be crash-looping, so ask
# the server itself whether it answers the Minecraft protocol.
log "waiting for the server to answer (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
healthy=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker exec "$CONTAINER" mc-monitor status --host localhost >/dev/null 2>&1; then
        healthy=true
        break
    fi
    sleep 10
done

if [ "$healthy" = true ]; then
    log "DEPLOY OK at ${NEW_SHA:0:8}"
    rcon say "Update complete. Welcome back."
    exit 0
fi

# Unattended deploys must not leave the server down until someone notices.
log "HEALTH CHECK FAILED at ${NEW_SHA:0:8} - rolling back to ${OLD_SHA:0:8}"
git reset --hard "$OLD_SHA"
chown -R 1000:1000 data
$COMPOSE up -d --build
log "rolled back; investigate with: docker logs --tail 100 $CONTAINER"
exit 1
