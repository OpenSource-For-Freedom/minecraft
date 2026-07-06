# Deploying to a DigitalOcean Droplet

Run the server in the cloud so friends can join from anywhere. Do this only
after it works locally — the cloud setup is identical to local, just on a rented
Linux box.

## 1. Create the Droplet

On the **Create Droplet** page:

| Setting | Choice | Why |
|---|---|---|
| Region | Closest to your players (e.g. NYC1) | Lower ping |
| Image | **Marketplace → Docker on Ubuntu 22.04** | Docker + Compose preinstalled |
| Plan | **Basic → Premium Intel/AMD → 8 GB / 4 vCPU (~$48/mo)** | Modpack needs ~6 GB usable; 4 GB crashes |
| Authentication | **SSH Key** (not password) | Secure, no password to leak |
| Backups | Optional (+~20%) | Extra safety net beyond our backup script |
| Hostname | e.g. `educraft` | — |

> **Do not pick the 4 GB plan.** `MAX_MEMORY` is 4 GB, and Forge/KubeJS need
> headroom on top of that. 8 GB is the floor for this pack.

## 2. Open the firewall

Docker bypasses the Ubuntu `ufw` firewall, so use the **DigitalOcean Cloud
Firewall** (Networking → Firewalls). Inbound rules:

| Type | Port | Sources |
|---|---|---|
| SSH | 22 | Your IP only |
| Custom TCP | 25565 | All IPv4 + IPv6 (Minecraft) |

BlueMap (8100) stays bound to localhost — reach it via an SSH tunnel, don't
open it publicly.

## 3. Deploy

SSH in (`ssh root@YOUR_DROPLET_IP`), then:

```bash
git clone https://github.com/OpenSource-For-Freedom/minecraft.git
cd minecraft
docker compose up -d --build
docker logs -f minecraft-java   # wait for: Done (...)! For help, type "help"
```

First boot installs Forge + downloads all mods (a few minutes). The world
generates fresh on 1.20.1 — no old-world version conflicts.

## 4. Connect & admin

- Players connect to **`YOUR_DROPLET_IP`** (port 25565 is the default, no need to type it).
- Add players to the whitelist live:
  ```bash
  docker exec -i minecraft-java rcon-cli whitelist add USERNAME
  ```
- You (`Melfonz1960`) are already set as the only op.

## 5. Backups on the droplet

The PowerShell backup/playtime scripts are **Windows-only**. On Linux, back up
with a cron job instead:

```bash
# Save + tar the important data nightly at 4am
0 4 * * * docker exec minecraft-java rcon-cli save-all && \
  tar czf ~/mc-backup-$(date +\%F).tgz -C ~/minecraft/data world ops.json whitelist.json server.properties
```

> The daily **playtime limiter** (`playtime_limit.ps1`) is Windows-only too.
> A Linux (cron + rcon) version isn't written yet — ask for it when you move here.

## Later: add a domain

Only if the project sticks. Buy a domain, then in DigitalOcean **Networking →
Domains** add an **A record** pointing `play.yourdomain.com` → droplet IP.
Players then use the name instead of the IP. Not needed to play.
