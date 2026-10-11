#!/usr/bin/env python3
"""No per-player data may ever be tracked in data/world/, in a PUBLIC repo.

data/world/ is NOT tracked at all any more - tests/test_world_not_tracked.py
is what enforces that, and it is the check that matters. This one is the
second line of defence for the case where the world becomes tracked again
regardless: whatever else were to ship, nothing that identifies or
describes a specific real kid: exact inventory, position,
playtime, or - as of the hub feature in hub.js - their saved home
coordinates. See .gitignore's comments next to data/world/ for the full list
and why each entry is there.

This checks `git ls-files`, not the working directory. A .gitignore rule only
stops an *accidental* `git add`; it does nothing against someone running
`git add -f` on a path they believe is fine, or a future mod writing a new
per-player file under a path this list has not been taught about yet. This is
the check that catches both, by refusing to let a build go green while any of
the excluded paths - or anything shaped like them - is actually tracked.

The UUID-filename check exists because Minecraft's own convention for
per-player files (playerdata/<uuid>.dat, stats/<uuid>.json,
advancements/<uuid>.json) is to name the file after the player's UUID. A
mod adding a NEW per-player file under some other directory, not yet one of
the ones named below, is still very likely to follow that convention - so
catching the shape, not just the known paths, is what gives this test a
chance against a file nobody has thought to exclude by name yet.
"""
import re
import subprocess
import sys

# Mirrors the data/world/ block in .gitignore. If that block changes, this
# must change with it - there is no single source of truth between the two
# because .gitignore controls `git add` and this controls `git ls-files`,
# and both need to independently refuse the same paths.
FORBIDDEN_PREFIXES = (
    "data/world/playerdata/",
    "data/world/stats/",
    "data/world/advancements/",
    "data/world/data/",
)
FORBIDDEN_EXACT = (
    "data/world/kubejs_persistent_data.nbt",
    "data/world/session.lock",
)

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout
    return [line for line in out.splitlines() if line]


def main() -> int:
    files = tracked_files()
    world_files = [f for f in files if f.startswith("data/world/")]

    failed = False

    for f in world_files:
        for prefix in FORBIDDEN_PREFIXES:
            if f.startswith(prefix):
                failed = True
                print(f"FAIL: {f} is tracked under {prefix} - per-player data "
                      f"must never be committed, see .gitignore")
                break
        else:
            if f in FORBIDDEN_EXACT:
                failed = True
                print(f"FAIL: {f} is tracked - per-player data must never be "
                      f"committed, see .gitignore")
            elif UUID_RE.search(f):
                failed = True
                print(f"FAIL: {f} is tracked and its name looks like a "
                      f"per-player UUID file")
                print("      even if this exact path was not on the excluded "
                      "list, that naming pattern always means per-player data")

    if failed:
        print("\nRemove the file(s) from git (git rm --cached <path>), add a "
              ".gitignore rule if one is missing, and re-check.")
        return 1

    print(f"  checked {len(world_files)} tracked files under data/world/")
    print("  PASS: no per-player data tracked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
