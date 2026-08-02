#!/usr/bin/env bash
# One-time bootstrap for ubuntu-Minecraft-V1 (plain Ubuntu 24.04 image,
# NOT the Docker marketplace image, so Docker must be installed first).
# Run as root:  bash bootstrap_droplet.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "== Installing Docker Engine + Compose v2 + git (Ubuntu repos, no curl|sh) =="
apt-get update
apt-get install -y docker.io docker-compose-v2 git
systemctl enable --now docker
docker compose version

echo "== Cloning / updating the server repo =="
cd /root
if [ ! -d minecraft ]; then
    git clone https://github.com/OpenSource-For-Freedom/minecraft.git
fi
cd minecraft
git pull --ff-only

# Git runs as root and rewrites tracked files in data/, but the container runs
# as uid 1000 and boot-loops with AccessDeniedException if it can't write them.
chown -R 1000:1000 data

echo "== Starting the server (first boot installs Forge + mods, takes minutes) =="
docker compose up -d --build

echo
echo "Bootstrap done. Watch startup with:  docker logs -f minecraft-java"
echo "Ready when you see:  Done (...)! For help, type \"help\""
echo
echo "REMINDER: attach a DigitalOcean Cloud Firewall (Networking > Firewalls):"
echo "  - SSH 22        : your IP only"
echo "  - TCP 25565     : all IPv4/IPv6 (Minecraft)"
echo "  - nothing else  : BlueMap 8100 stays localhost-only (SSH tunnel)"
