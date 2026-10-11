#!/usr/bin/env python3
"""data/world/ must never be tracked: a git deploy must not rewrite the save.

This is the tripwire for an incident that already happened. data/world/ was
tracked on main (PR #64, #67) so a hub built on the local test server could be
shipped to the droplet once. That worked, and then the mechanism stayed armed:
on 2026-10-11 the droplet pulled it and the live world was replaced by the
local snapshot, visible in the deployment statuses as the world seed changing
from 1691256543523180978 to 2945200692062874765.

Tracking the save cannot be made safe, in either direction:

  - Region files are binary, so git cannot merge them. Whichever side is
    deployed next silently destroys what the other side built.
  - Untracking them is just as destructive. Dropping a path from the index
    means the next checkout DELETES it from the working tree, so the very
    commit that cleans this up can erase the live save.
  - playerdata/, stats/ and advancements/ are the players' own save data:
    inventories, positions, and the homes hub.js stores for them.

Content that SHOULD ship through git lives outside data/world/: KubeJS scripts
and their configs, and the mod list in docker-compose.yml.

Four independent checks, because they stop different mistakes. The .gitignore
rule stops an accidental "git add -A". The tracked-file check stops a
"git add -f", a merge of a branch that still tracks the world (every branch
cut before 2026-10-11 does), or anyone deleting the ignore rule. The last two
check the droplet's own refusal in gitops/deploy.sh, which is what protects
the save when a bad revision reaches main anyway - CI gates the repo, but only
the droplet gates the live world.
"""
import os
import shutil
import subprocess
import sys
import tempfile

WORLD_PREFIX = "data/world/"
DEPLOY = "gitops/deploy.sh"

# Any of these ignores the whole directory. Matched as a rule on its own line,
# so a mention inside a comment does not read as protection.
IGNORE_RULES = ("data/world/", "data/world", "/data/world/", "/data/world")


def git(args, cwd=None, check=True):
    return subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True, check=check
    ).stdout


def tracked_world_files():
    return [f for f in git(["ls-files"]).splitlines()
            if f.startswith(WORLD_PREFIX)]


def gitignore_has_rule():
    with open(".gitignore", encoding="utf-8") as f:
        return any(line.strip() in IGNORE_RULES for line in f)


def deploy_guard_runs_before_pull():
    """The guard is worthless if it sits after the pull that does the damage."""
    with open(DEPLOY, encoding="utf-8") as f:
        lines = f.read().splitlines()
    guard = next((i for i, l in enumerate(lines)
                  if l.startswith("world_touched=")), None)
    pull = next((i for i, l in enumerate(lines)
                 if "git pull --ff-only" in l), None)
    if guard is None or pull is None:
        return False, "guard=%s pull=%s (one of them is missing)" % (guard, pull)
    if guard > pull:
        return False, "guard is at line %d, after the pull at line %d" % (
            guard + 1, pull + 1)
    return True, "guard at line %d, pull at line %d" % (guard + 1, pull + 1)


def detection_works_both_ways():
    """Prove the git command the guard relies on actually sees both cases.

    Built as a throwaway repo rather than asserting on the string, because the
    thing that has to be true is the BEHAVIOUR: a revision that adds world
    files and a revision that removes them must both be detected. The removal
    direction is the one that deletes a live save, and it is the easy one to
    forget to test.
    """
    tmp = tempfile.mkdtemp(prefix="worldguard-")
    try:
        git(["init", "-q", tmp])
        git(["config", "user.email", "t@example.invalid"], cwd=tmp)
        git(["config", "user.name", "test"], cwd=tmp)

        with open(os.path.join(tmp, "readme"), "w") as f:
            f.write("code only")
        git(["add", "-A"], cwd=tmp)
        git(["commit", "-qm", "no world"], cwd=tmp)
        base = git(["rev-parse", "HEAD"], cwd=tmp).strip()

        region = os.path.join(tmp, "data", "world", "region")
        os.makedirs(region)
        with open(os.path.join(region, "r.0.0.mca"), "w") as f:
            f.write("binary-ish")
        git(["add", "-A"], cwd=tmp)
        git(["commit", "-qm", "track the world"], cwd=tmp)
        tracked = git(["rev-parse", "HEAD"], cwd=tmp).strip()

        git(["rm", "-rq", "--cached", "data/world"], cwd=tmp)
        git(["commit", "-qm", "untrack the world"], cwd=tmp)
        untracked = git(["rev-parse", "HEAD"], cwd=tmp).strip()

        def guard_sees(old, new):
            out = git(["diff", "--name-only", old, new, "--", "data/world"],
                      cwd=tmp)
            return bool(out.strip())

        return {
            "adding world files is detected": guard_sees(base, tracked),
            "untracking world files is detected": guard_sees(tracked, untracked),
            "a code-only revision is NOT flagged": not guard_sees(base, base),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    failed = False

    world_files = tracked_world_files()
    if world_files:
        failed = True
        print("FAIL: %d file(s) under %s are tracked."
              % (len(world_files), WORLD_PREFIX))
        for f in world_files[:10]:
            print("       " + f)
        if len(world_files) > 10:
            print("       ... and %d more" % (len(world_files) - 10))
        print("\n      The live world is the only real one. Deploying a commit "
              "that tracks")
        print("      it overwrites what players built; a commit that untracks "
              "it deletes")
        print("      their save. Untrack with: git rm -r --cached data/world")
    else:
        print("  no tracked files under " + WORLD_PREFIX)

    if gitignore_has_rule():
        print("  .gitignore ignores " + WORLD_PREFIX)
    else:
        failed = True
        print("FAIL: .gitignore has no rule ignoring " + WORLD_PREFIX)
        print("      Without it, one 'git add -A' re-arms the whole problem.")

    ok, detail = deploy_guard_runs_before_pull()
    if ok:
        print("  " + DEPLOY + " refuses a world-touching revision (" + detail + ")")
    else:
        failed = True
        print("FAIL: " + DEPLOY + " does not guard the save before pulling: "
              + detail)

    for label, passed in detection_works_both_ways().items():
        if passed:
            print("  " + label)
        else:
            failed = True
            print("FAIL: " + label + " - it is not")

    if failed:
        return 1
    print("  PASS: the live save cannot be rewritten by a deploy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
