#!/usr/bin/env python3
"""Every server mod must either be in the client pack or be a known server-side mod.

Why this exists: Chunky was added to the server on 2026-08-12 and every player
was immediately locked out with "Incompatible FML modded server / Server mod
list is not compatible". The reasoning that let it through was that Chunky
registers no network channels, so it could not reject anyone. That is wrong.
Forge compares the whole mod list at ping time using each mod's displayTest
flag in mods.toml, independently of channels. A mod that leaves displayTest at
the MATCH_VERSION default makes every client without it incompatible.

So a mod may only be on the server and absent from the client pack if it is on
the allowlist below, meaning it has been observed not to break clients.
Adding a new server-only mod means proving that and adding it here deliberately.
"""
import json
import os
import re
import sys
import zipfile

COMPOSE = "docker-compose.yml"
PACK = "data/EduCraftClient.mrpack"

# Server-only mods proven not to flag clients as incompatible: each declares
# itself server-side in mods.toml, and all six were live while players joined.
SERVER_ONLY_OK = {
    "luckperms",        # permissions
    "profanityguard",   # chat filter
    "bluemap",          # web map
    "prismprotect",     # block-change logging and rollback
    "playtimestatistics",
    "terralith",        # datapack worldgen, server_side=required
}

def norm(name):
    """Reduce a jar filename to a comparable mod name.

    Strips the version (everything from the first -<digit> or _<digit>), the
    loader token, and separators. Without the loader strip, LuckPerms-Forge-5.4
    reduces to 'luckpermsforge' and never matches the allowlist entry
    'luckperms', which made the first version of this test fail on three mods
    that were perfectly fine.
    """
    name = name.replace("%20", " ").replace("%2B", "+")
    stem = re.split(r"[-_]\d", name.lower())[0]
    stem = re.sub(r"[-_ ]?(forge|fabric|neoforge|quilt|mc)$", "", stem)
    return stem.replace("-", "").replace("_", "").replace(" ", "")

def main():
    compose = open(COMPOSE, encoding="utf-8").read()
    m = re.search(r'MODS:\s*"([^"]+)"', compose, re.S)
    if not m:
        print("FAIL: no MODS list found in docker-compose.yml")
        return 1
    server = [os.path.basename(u.strip()) for u in m.group(1).split(",") if u.strip()]

    if not os.path.exists(PACK):
        print(f"FAIL: client pack missing at {PACK}")
        return 1
    with zipfile.ZipFile(PACK) as z:
        idx = json.loads(z.read("modrinth.index.json"))
    client = [os.path.basename(f["path"]) for f in idx["files"]]

    print(f"  server: {len(server)} mods, client pack: {len(client)} mods")
    ckeys = {norm(c) for c in client}

    offenders = []
    for jar in server:
        k = norm(jar)
        if k in ckeys or k in SERVER_ONLY_OK:
            continue
        offenders.append(jar)

    if offenders:
        print("\nFAIL: server mods absent from the client pack and not on the allowlist.")
        print("Each of these will show players 'Server mod list is not compatible':")
        for o in offenders:
            print(f"    {o}")
        print("\nFix by one of:")
        print("  - add the mod to data/EduCraftClient.mrpack so both sides match, or")
        print("  - remove it from the server, or")
        print("  - if it is genuinely server-side safe, add it to SERVER_ONLY_OK here")
        print("    with a note explaining how that was verified.")
        return 1

    print("  PASS: every server mod is either in the client pack or a known server-side mod")
    return 0

if __name__ == "__main__":
    sys.exit(main())
