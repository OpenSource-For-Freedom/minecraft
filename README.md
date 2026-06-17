# Minecraft Java Server 26.1.1

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
- To host and play on the same device

| Who | Address |
|---|---|
| You (this PC) | `localhost` |
| LAN friend | `172.26.130.246` |

Port: **25565** (default, no need to type it)

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
