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
`docker-compose.yml`, `Dockerfile`, `gitops/`, `alerts/`, `.github/`, the shell
scripts, and the mod list.

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
on a server.

You'll need Docker with Compose v2 (`docker compose`, with a space) and about
8 GB of RAM free. The first start downloads Forge and all the mods, so give it
a few minutes.

1. From your clone, start it:
   ```bash
   docker compose up -d --build
   docker logs -f minecraft-java
   ```
   Wait for `Done (...)! For help, type "help"`, then press Ctrl+C to stop
   following the log. The server keeps running.
2. On Linux, if the logs show `AccessDeniedException`, the container can't write
   to `data/`. Fix it with `sudo chown -R 1000:1000 data` and start it again.
3. The whitelist is on, so add yourself and give yourself op on your local
   copy:
   ```bash
   docker exec -i minecraft-java rcon-cli whitelist add YOUR_USERNAME
   docker exec -i minecraft-java rcon-cli op YOUR_USERNAME
   ```
4. In Minecraft (with the modpack installed), add a server with the address
   `localhost` and join.
5. After editing a KubeJS script, run `/reload` in game. For guide book
   changes, restart the server with `docker compose restart`.
6. When you're done, stop it with `docker compose down`. Your local world stays
   in `data/world/` for next time.

A few things to watch out for:

- Don't change `docker-compose.yml` or the `Dockerfile` to get things working
  locally. If something won't run, open an issue.
- Running the server creates a lot of files in `data/`. Most are ignored by git,
  but check `git status` before you commit and only commit the files you meant
  to change. Schematics you upload in game land in `data/schematics/` and
  shouldn't be committed. Builds go in `builds/` only.
- Your local server is yours. Nothing you do on it touches the real server.

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
