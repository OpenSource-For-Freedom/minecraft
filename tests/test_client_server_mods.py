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
    return 0

if __name__ == "__main__":
    sys.exit(main())
