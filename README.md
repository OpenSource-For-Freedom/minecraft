# Minecraft Server (Forge 1.20.1)
[![trivy](https://github.com/OpenSource-For-Freedom/minecraft/actions/workflows/trivy.yml/badge.svg)](https://github.com/OpenSource-For-Freedom/minecraft/actions/workflows/trivy.yml)

A whitelist-only, hardened Minecraft server for kids and their approved friends.
Only players you add can join. See `docker-compose.yml` for all safety settings.

## ENTER HERE: [EduCraft](https://opensource-for-freedom.github.io/minecraft_website/)

## What you need

- **Docker** with Compose. On Windows/Mac, install Docker Desktop; on Linux, install Docker plus the Compose v2 plugin (`docker compose`, or the standalone `docker-compose` binary).
- **8 GB RAM** free. The pack needs about 6 GB; 4 GB crashes.

## First-time setup

1. Get the files:
   ```bash
   git clone https://github.com/OpenSource-For-Freedom/minecraft.git
   cd minecraft
   ```
2. In `docker-compose.yml`, set `OPS` to **your** Minecraft username (you become the only admin), and add your kids + their friends to `WHITELIST` (comma-separated usernames).
3. **Linux only:** the server runs as user `1000`, so its data folder must be owned by that user or it can't write and won't start:
   ```bash
   sudo chown -R 1000:1000 data
   ```
   Skip this on Windows/Mac. If you ever see `AccessDeniedException: /data/server.properties`, this is the fix.
4. Start it:
   ```bash
   docker compose up -d
   ```
   First boot installs Forge and downloads ~20 mods, so give it a few minutes. Follow along with `docker logs -f minecraft-java` until you see `Done (...)! For help, type "help"`.

## Players join with the mod pack

The mods live in `docker-compose.yml` (the `MODS` list) and download on their own. Players need the **same** mods to connect: give them `data/EduCraftClient.mrpack` and have them import it into the Modrinth App, Prism, or ATLauncher. It carries the exact jar versions the server runs, plus the two client-only map mods.

## Updating the in-game guide book

The `/guide` command and the book new players get on first join both come from `data/patchouli_books/educraft_guide/`. Patchouli's server can only tell a player's client *which* book to open by ID - the actual pages have to already exist on that player's own installed pack, bundled into `data/EduCraftClient.mrpack`'s `overrides/patchouli_books/` folder. If you edit the guide book but don't rebuild the `.mrpack`, `/guide` will silently do nothing for anyone still on the old pack - no error, no crash, it just won't open.

After editing anything under `data/patchouli_books/`:

1. On Windows, run `.\sync_guide_to_mrpack.ps1` - it rebuilds `data/EduCraftClient.mrpack` with the current book content.
2. Bump the `(vN)` marker in `book.json`'s `"subtitle"` so players can tell whether their copy is current just by opening the book.
3. Commit the updated `.mrpack`, and have players reimport/update it in their launcher.

## Who can play (the safety control)

Only whitelisted usernames can join. Add/remove kids live without restarting:

```powershell
docker exec -i minecraft-java rcon-cli whitelist add USERNAME
docker exec -i minecraft-java rcon-cli whitelist remove USERNAME   # kicked immediately
docker exec -i minecraft-java rcon-cli whitelist list
```

## Start / Stop

```powershell
# Start
docker compose up -d

# Stop
docker compose down

# Restart
docker restart minecraft-java
```

## Connect

| Who | Address |
|---|---|
| You (same PC) | `localhost` |
| Same home network | your PC's local IP, e.g. `192.168.1.x` (find it with `ipconfig` on Windows or `ip addr` on Linux) |
| Over the internet | your public IP, after forwarding port 25565 on your router |

Port: **25565** (the default, no need to type it).

## Server Commands (via RCON)

```powershell
# Op a player (make admin)
docker exec -i minecraft-java rcon-cli op USERNAME

# Kick a player
docker exec -i minecraft-java rcon-cli kick USERNAME

# Kill a player
docker exec -i minecraft-java rcon-cli kill USERNAME

# Ban a player
docker exec -i minecraft-java rcon-cli ban USERNAME

# Unban
docker exec -i minecraft-java rcon-cli pardon USERNAME

# Whitelist add/remove
docker exec -i minecraft-java rcon-cli whitelist add USERNAME
docker exec -i minecraft-java rcon-cli whitelist remove USERNAME

# Change gamemode for a player
docker exec -i minecraft-java rcon-cli gamemode creative USERNAME
docker exec -i minecraft-java rcon-cli gamemode survival USERNAME

# Give item
docker exec -i minecraft-java rcon-cli give USERNAME minecraft:diamond 64

# Teleport player
docker exec -i minecraft-java rcon-cli tp USERNAME X Y Z

# View live logs
docker logs -f minecraft-java
```

## Files

| Path | Purpose |
|---|---|
| `data/server.properties` | All server settings |
| `data/ops.json` | Admin players |
| `data/whitelist.json` | Whitelist |
| `data/banned-players.json` | Bans |
| `data/world/` | World data |

> Edit `server.properties` then run `docker restart minecraft-java` to apply changes.
