#!/usr/bin/env bash
# Apply gitops/world_settings.conf to the running server. Called by deploy.sh
# once the server is healthy; safe to run by hand and safe to run twice.
#
# The values are PARSED out of the conf with a strict pattern, never sourced:
# this runs as root, and a conf that could execute code would turn a reviewed
# one-line change into an arbitrary-command channel.
set -euo pipefail

REPO_DIR=${REPO_DIR:-/root/minecraft}
CONTAINER=${CONTAINER:-minecraft-java}
CONF="$REPO_DIR/gitops/world_settings.conf"

setting() { sed -n "s/^$1=\"\\([^\"]*\\)\"\$/\\1/p" "$CONF" | head -n 1; }

SPAWN=$(setting SPAWN)
if ! [[ $SPAWN =~ ^-?[0-9]+\ -?[0-9]+\ -?[0-9]+$ ]]; then
    echo "apply_world_settings: SPAWN must be three whole numbers 'X Y Z', got '${SPAWN}'" >&2
    exit 1
fi

docker exec -i "$CONTAINER" rcon-cli "setworldspawn $SPAWN"
# level.dat is only written on save, and gitops/world_info.py reads that file,
# so flush now or the deploy status would report the previous spawn.
docker exec -i "$CONTAINER" rcon-cli "save-all flush" >/dev/null
echo "apply_world_settings: spawn is $SPAWN"
