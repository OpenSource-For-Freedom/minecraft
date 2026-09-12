#!/usr/bin/env python3
"""Every server mod must either be in the client pack or be a deliberate server-side choice.

CORRECTION, 2026-08-12. The first version of this file claimed Chunky locked
players out because it leaves displayTest at the MATCH_VERSION default in
mods.toml, while the other server-only mods declare themselves server-side.
That was wrong, and reading the jars disproved it: terralith, luckperms,
profanityguard, bluemap, prismprotect and playtimestatistics ALL omit
displayTest in exactly the same way, and every one of them was live while
players joined successfully. Chunky never blocked anyone.

The red X and "Server mod list is not compatible" are ADVISORY. Forge shows
them whenever the server runs mods the client lacks, which is the normal state
of this server. The actual cause of players being unable to connect was upstream
network filtering of the owner's home IP by DigitalOcean (ticket #12677589).

So this test is NOT a compatibility guarantee, and must not be read as one.
What it is: a tripwire that makes adding a server-only mod a deliberate,
reviewed act rather than a silent one, and that catches the real mistake of a
client-required mod being added to the server but forgotten in the pack. Any
mod on SERVER_ONLY_OK is one someone decided belongs on the server alone.

Do not remove a mod from the server because a client shows a red X. Check
reachability first.
"""
import json
import os
import re
import sys
import urllib.parse
import zipfile

COMPOSE = "docker-compose.yml"
PACK = "data/EduCraftClient.mrpack"

# Mods deliberately installed on the server only. All are client_side optional
# or unsupported on Modrinth, meaning the client never needs the jar to play.
# Adding to this set is a decision, not a formality: it says "this belongs on
# the server alone and the pack does not need updating".
SERVER_ONLY_OK = {
    "luckperms",         # permissions
    "profanityguard",    # chat filter
    "bluemap",           # web map
    "prismprotect",      # block-change logging and rollback
    "playtimestatistics",
    "terralith",         # datapack worldgen, client_side=optional
    "dungeonsarise",     # When Dungeons Arise, client_side=unsupported
    # spark is client_side=optional AND server_side=optional on Modrinth, so
    # neither side is inferable from its metadata: it is a profiler, and the
    # thing worth profiling is the server tick loop. Kept out of the pack on
    # purpose so adding it costs no family a re-import.
    "spark",
}

def norm(name):
    """Reduce a jar filename to a comparable mod name.

    Strips the version (everything from the first -<digit> or _<digit>), the
    loader token, and separators. Without the loader strip, LuckPerms-Forge-5.4
    reduces to 'luckpermsforge' and never matches the allowlist entry
    'luckperms', which made the first version of this test fail on three mods
    that were perfectly fine.
    """
    name = urllib.parse.unquote(name)
    stem = re.split(r"[-_]\d", name.lower())[0]
    stem = re.sub(r"[-_ ]?(forge|fabric|neoforge|quilt|mc)$", "", stem)
    return re.sub(r"[-_ \[\]]", "", stem)

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

    # The LOADER has to match too, and it is easier to get wrong than the mods
    # because nothing downloads it from a URL anyone reviews. With only
    # VERSION: "1.20.1" set, the image installs whatever Forge build is promoted
    # at container start; a local boot on 2026-09-12 got 47.4.10 while this pack
    # declared 47.4.20 and Forge had shipped 47.4.23. Pin it, and keep the pin
    # equal to what the pack tells families to install.
    fm = re.search(r'^\s*FORGE_VERSION:\s*"([^"]+)"', compose, re.M)
    pack_forge = idx.get("dependencies", {}).get("forge")
    if not fm:
        print("\nFAIL: FORGE_VERSION is not pinned in docker-compose.yml.")
        print("  Without it the loader is resolved as 'latest promoted for this")
        print("  Minecraft version' on every container start, so a restart can")
        print("  change the loader under every mod with no commit and no review.")
        print(f"  The client pack declares forge {pack_forge}; pin that.")
        return 1
    if not pack_forge:
        print("\nFAIL: the client pack declares no forge dependency to compare against.")
        return 1
    if fm.group(1) != pack_forge:
        print("\nFAIL: server and client pack disagree about the Forge build.")
        print(f"    docker-compose.yml FORGE_VERSION : {fm.group(1)}")
        print(f"    {PACK} declares          : {pack_forge}")
        print("  Set them to the same build. Bumping one alone means families")
        print("  install a loader the server is not running.")
        return 1
    print(f"  PASS: loader pinned and matched, forge {pack_forge} on both sides")
    return 0

if __name__ == "__main__":
    sys.exit(main())
