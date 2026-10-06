# Contributing to EduCraft

EduCraft is a whitelist-only Minecraft server for kids. All contributions go
through GitHub. Fork the repo, make your changes on your fork, and open a pull
request. I review everything before it gets merged.

## Ground rules

- Contributors don't get server access. That means no op, no whitelist spot,
  no SSH, no RCON and no console. You don't need any of it to contribute.
- Anything merged to `main` deploys to the live server automatically, and the
  players are kids. That's why every change gets reviewed, no matter who sent
  it.
- Keep everything family friendly. That covers builds, signs, books and any
  other text.
- Don't put personal info in files, commits or PR descriptions. This repo is
  public.

## What you can work on

| Area | Location | Notes |
|---|---|---|
| Builds | `builds/<build-name>/` | Structures like spawn, hubs and shops, saved as schematics |
| Guide book | `data/patchouli_books/educraft_guide/` | The in-game EduCraft guide (Patchouli JSON) |
| Server scripts | `data/kubejs/server_scripts/` | KubeJS gameplay scripts |

These are off limits and PRs that change them will be closed:
`docker-compose.yml`, `docker-compose.local.yml`, `Dockerfile`, `gitops/`,
`alerts/`, `.github/`, the shell scripts, and the mod list.

## Getting set up

1. Install the modpack from `data/EduCraftClient.mrpack` using a launcher that
   supports `.mrpack` files (Modrinth App or Prism Launcher). It's Forge 1.20.1
   with the same mods the server runs.
2. Build in a single-player world. Creative mode is fine there. To test on a
   real server, see "Testing on a local server" below.
3. Fork this repo and clone your fork.

## Testing on a local server

You can run your own copy of the server in Docker using the Dockerfile and
`docker-compose.yml` in this repo. It's the same setup the real server uses, so
it's the best way to test scripts, guide book changes, and how a build looks
on a server. Nothing you do on your local server touches the real one.

### What you need

- Docker with Compose v2. On Windows or Mac, install
  [Docker Desktop](https://docs.docker.com/get-docker/). On Linux, install
  [Docker Engine](https://docs.docker.com/engine/install/) and the Compose
  plugin. Check that it works:
  ```bash
  docker --version
  docker compose version
  ```
  Use `docker compose` with a space. The old `docker-compose` (v1) doesn't
  work with this setup.
- About 8 GB of free RAM. The server is capped at 6.5 GB.
- Git, and the modpack installed in your launcher (see "Getting set up").

### First start

```bash
# Clone your fork and go into it
git clone https://github.com/YOUR_GITHUB_NAME/minecraft.git
cd minecraft

# Label your copy as a local test server (one time, see below)
printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml\nCOMPOSE_PATH_SEPARATOR=:\n' > .env

# Build the image and start the server in the background
docker compose up -d --build

# Follow the log
docker logs -f minecraft-java
```

The `.env` line makes Docker also load `docker-compose.local.yml`, which
changes the server's message in the Multiplayer list to a red
**LOCAL TEST SERVER**. Without it, your copy looks exactly like the real server.
`.env` is ignored by git, and the real server never reads it. On Windows
PowerShell, create the file with:

```powershell
"COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml`nCOMPOSE_PATH_SEPARATOR=:" | Out-File -Encoding ascii .env
```

If the label doesn't show, run `docker compose config | grep MOTD`. It should
say LOCAL TEST SERVER.

The first start downloads Forge and all the mods, so it takes a few minutes.
When you see `Done (...)! For help, type "help"` the server is ready. Press
Ctrl+C to stop following the log. The server keeps running.

The whitelist is on, so add yourself and make yourself op on your local copy:

```bash
docker exec -i minecraft-java rcon-cli whitelist add YOUR_USERNAME
docker exec -i minecraft-java rcon-cli op YOUR_USERNAME
```

### Connecting to your local server

The server won't show up in your launcher or in Minecraft's server list on its
own. That list only finds single-player worlds opened to LAN, and a Docker
server doesn't announce itself. You have to add it by hand.

1. Check that the server is up:
   ```bash
   docker ps
   ```
   You should see `minecraft-java` with a status of `Up` and
   `0.0.0.0:25565->25565`. Then check the log:
   ```bash
   docker logs --tail 50 minecraft-java
   ```
   Wait until you see `Done (...)! For help, type "help"`.
2. In Modrinth App (or Prism), launch the EduCraft instance you imported from
   `data/EduCraftClient.mrpack`. A plain Forge instance won't connect.
3. In Minecraft, go to Multiplayer, click Add Server, enter `localhost` as the
   Server Address, click Done, and join. If `localhost` doesn't work, try
   `127.0.0.1`. Name the entry something like "Local test" so you don't mix it
   up with the real server.

### Your local world

Your local world is not a copy of the real one. The world files aren't in this
repo (they hold the players' data), so your server makes its own:

- **Terrain:** `SEED` in `docker-compose.yml` is the real server's seed, so a
  new local world has the same land.
- **Spawn:** the spawn point is saved in the world, not the seed, so set it once
  to match the real server. Run this in game (you're op on your copy):
  ```
  /setworldspawn 587 98 87
  ```
  New players and anyone without a bed will then spawn where they do on the real
  server. The real server's spawn is set from `gitops/world_settings.conf` on
  every deploy, so that file is the source of truth, not this page.
- **Builds:** nothing built on the real server is in your copy, so the spawn
  spot will be bare land.
- **Hub:** the real server has no hub set yet. If you're testing the hub and
  home commands, stand where you want it and run `/hub set`.

If your local world was made before the seed was added, start over with a
fresh world (below), then run the `/setworldspawn` command above.

The seed comes from the real server. After each deploy the droplet reports it
and the spawn on the repo's Deployments page (`seed=...; spawn=X,Y,Z`). To move
the spawn, change `SPAWN` in `gitops/world_settings.conf` and update the command
above to match; `tests/test_world_settings.py` fails if they disagree.

### Docker commands

| What | Command |
|---|---|
| Start the server | `docker compose up -d` |
| Start after changing the Dockerfile or pulling updates | `docker compose up -d --build` |
| Stop the server | `docker compose stop` |
| Stop and remove the container (your world is kept) | `docker compose down` |
| Restart | `docker compose restart` |
| Is it running? | `docker ps` |
| Follow the log | `docker logs -f minecraft-java` |
| Last 100 log lines | `docker logs --tail 100 minecraft-java` |
| CPU and memory use | `docker stats minecraft-java` |
| Open the server console | `docker exec -it minecraft-java rcon-cli` (type `exit` to leave) |
| Run one server command | `docker exec -i minecraft-java rcon-cli COMMAND` |

Server commands you'll probably use, either in the console, with
`rcon-cli COMMAND`, or in game with a `/` in front:

| What | Command |
|---|---|
| Who's online | `list` |
| Add yourself to the whitelist | `whitelist add YOUR_USERNAME` |
| Make yourself op | `op YOUR_USERNAME` |
| Switch to creative or survival | `gamemode creative YOUR_USERNAME` / `gamemode survival YOUR_USERNAME` |
| Reload KubeJS scripts and datapacks | `reload` |
| Save the world now | `save-all` |
| Teleport to coordinates | `tp YOUR_USERNAME X Y Z` |

### Testing your changes

- KubeJS scripts: edit the file in `data/kubejs/server_scripts/`, then run
  `reload`. Errors show up in `docker logs minecraft-java` and in
  `data/logs/kubejs/server.log`.
- Guide book: edit the JSON, then `docker compose restart`.
- Builds: copy your schematic `.nbt` from `.minecraft/schematics/` into your
  local server with Create's Schematic Table and print it with a
  Schematicannon, or load it with a structure block.
- The web map (BlueMap) is at http://localhost:8100 while the server is running.

### Updating your copy

When the main repo changes, pull the changes into your fork and rebuild:

```bash
# One time: point "upstream" at the main repo
git remote add upstream https://github.com/OpenSource-For-Freedom/minecraft.git

# Every time you want the latest
git checkout main
git pull upstream main
docker compose up -d --build
```

### Starting over with a fresh world

This deletes your local world. It doesn't affect anything else.

```bash
docker compose down
rm -rf data/world
docker compose up -d
```

On Linux you may need `sudo rm -rf data/world`, since the server's files are
owned by user 1000.

### Cleaning up

To remove the container and the image when you're done with it:

```bash
docker compose down --rmi all
```

### Troubleshooting

- **`AccessDeniedException` in the log (Linux):** the container runs as user
  1000 and can't write to `data/`. Run `sudo chown -R 1000:1000 data`, then
  `docker compose up -d`.
- **Port 25565 is already in use:** another Minecraft server is running on your
  computer. Stop it, then run `docker compose up -d` again.
- **Container keeps restarting or gets killed:** usually not enough memory.
  Close other programs, and in Docker Desktop give Docker at least 8 GB under
  Settings, Resources.
- **Apple Silicon Mac crashes when a mob dies or a block changes:** the image ships
  an x86_64 library that one of the mods needs. Run
  `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose up -d --build`. It's
  slower but works.
- **"Incompatible FML modded server" when joining:** your modpack doesn't match
  the server. Reinstall it from `data/EduCraftClient.mrpack` in your clone.
- **"You are not whitelisted on this server":** add yourself with
  `docker exec -i minecraft-java rcon-cli whitelist add YOUR_USERNAME`.
- **"Failed to verify username":** the server only accepts real Minecraft
  accounts. Sign in to your launcher with your Microsoft account, not an
  offline account.
- **"Connection refused" or the server shows as offline:** it hasn't finished
  starting yet (check `docker logs --tail 50 minecraft-java`), or Docker is
  running on a different computer or VM. In that case use that machine's IP
  address instead of `localhost`.
- **A stuck container won't recreate:** `docker rm -f minecraft-java`, then
  `docker compose up -d`.

### Before you commit

- Don't change `docker-compose.yml` or the `Dockerfile` to get things working
  locally. If something won't run, open an issue.
- Running the server creates a lot of files in `data/`. Most are ignored by git,
  but run `git status` before you commit and only commit the files you meant to
  change. Schematics uploaded in game land in `data/schematics/` and shouldn't
  be committed. Builds go in `builds/` only.

## Submitting a build

1. Build it in your single-player world.
2. Save it as a schematic using Create's Schematic and Quill (saves to
   `.minecraft/schematics/`) or a vanilla structure block (saves to the world's
   `generated/minecraft/structures/` folder). You'll end up with an `.nbt` file.
3. Make a folder for it at `builds/<build-name>/` and put in:
   - the `.nbt` file
   - a `README.md` with what it is, the size (X x Y x Z), which mods' blocks it
     uses, and anything needed to place it (which way it faces, what the
     redstone does, what goes in the chests)
   - one or two screenshots
4. Open a pull request.

Builds don't get placed in the world automatically. I check each one in
single-player first and then place it on the server myself.

Please don't use command blocks or spawners, and leave chests and other
containers empty. Regular redstone is fine, just explain what it does.

## Guide book and scripts

- Guide pages are JSON. Copy an existing page from
  `data/patchouli_books/educraft_guide/en_us/entries/` and follow the same
  layout.
- KubeJS scripts run on the live server, so they get the most careful review.
  Keep each PR small, explain what the script does, and say how you tested it
  on your local server. Run `python3 tests/test_kubejs_script_hazards.py` before
  opening the PR.
- CI has to pass before anything is merged.

## Pull requests

- One build, page or feature per PR.
- Say what you changed and add a screenshot if it's something you can see in
  game.
- I'll probably have questions or ask for changes on most PRs.
- Don't add new mods. If a build needs a mod that isn't in the pack, open an
  issue first so we can talk about it.
