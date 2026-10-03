# Contributing to EduCraft

EduCraft is a whitelist-only Minecraft server for kids. All contributions go
through GitHub. Fork the repo, make your changes on your fork, and open a pull
request. I review everything before it gets merged.

## Ground rules

- Contributors don't get server access. That means no op, no whitelist spot,
  no SSH, no RCON and no console. You don't need any of it to contribute.
- Contributors don't get write access to this repo. Work from your fork.
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
2. Build and test in a single-player world. Creative mode is fine there.
3. Fork this repo and clone your fork.

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
  in single-player. Run `python3 tests/test_kubejs_script_hazards.py` before
  opening the PR.
- CI has to pass before anything is merged.

## Pull requests

- One build, page or feature per PR.
- Say what you changed and add a screenshot if it's something you can see in
  game.
- I'll probably have questions or ask for changes on most PRs.
- Don't add new mods. If a build needs a mod that isn't in the pack, open an
  issue first so we can talk about it.
