#!/usr/bin/env python3
"""The daily playtime limiter must exist, be wired, and be observable.

BACKGROUND, and the reason this test exists at all.

For roughly a month this repository told operators that no playtime limit was
running. It was wrong. `playtime_limit.ps1` (Windows, genuinely dead on the
droplet) and `data/kubejs/server_scripts/playtime_limit.js` (KubeJS, tracked,
mounted and loading on every boot) are two different limiters. PR #21 deleted
the first and wrote "there is currently no time limit of any kind" into
DEPLOY.md and the CHANGELOG, conflating them.

That is a worse failure than the one it described. A parent told no control
exists goes and finds another way to limit their child's screen time, or
decides this server is unsuitable. Being wrong in the reassuring direction is
bad; being wrong in the alarming direction is also bad, and this was the second.

The root cause was not the deletion. It was that NOTHING was observable: no log
line, no command, no way to answer "is it on?" without reading source. So this
test guards three things:

  1. the limiter script is present and still does what it claims,
  2. it announces itself, so the question is answerable from `docker logs`,
  3. the documentation does not re-assert the falsehood.

It cannot prove the limiter runs on the droplet. `docker logs minecraft-java |
grep playtime` proves that, and DEPLOY.md now says so.
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "data", "kubejs", "server_scripts", "playtime_limit.js")
CONFIG = os.path.join(ROOT, "data", "kubejs", "config", "playtime_limits.json")
DEPLOY = os.path.join(ROOT, "DEPLOY.md")
COMPOSE = os.path.join(ROOT, "docker-compose.yml")
GITIGNORE = os.path.join(ROOT, ".gitignore")

failures = []


def check(label, condition, detail=""):
    if condition:
        print("PASS  %s" % label)
    else:
        print("FAIL  %s%s" % (label, (" - " + detail) if detail else ""))
        failures.append(label)


check("limiter script exists", os.path.isfile(SCRIPT))
check("limiter config exists", os.path.isfile(CONFIG))
if failures:
    sys.exit(1)

with io.open(SCRIPT, encoding="utf-8") as fh:
    src = fh.read()

# The behaviours the limiter is documented as having. If one of these is removed,
# DEPLOY.md becomes wrong again in the other direction.
check("counts playtime per player", "ptSeconds" in src)
check("resets on date rollover", "ptDate" in src and "LocalDate" in src)
check("warns before the cap", "playtime left today" in src)
check("kicks at the cap", ".kick(" in src)
check("ops are exempt, checked live", "isOp()" in src)
check("reads the config file", "playtime_limits.json" in src)

# The observability that was missing, and whose absence is why a wrong claim
# survived a month unchallenged.
check("announces itself on load", "[playtime] limiter ACTIVE" in src)
check("registers the /playtime command",
      "Commands.literal('playtime')" in src)
check("uses the same command idiom as onboarding.js",
      "ServerEvents.commandRegistry" in src)

with io.open(CONFIG, encoding="utf-8") as fh:
    try:
        cfg = json.load(fh)
    except ValueError as exc:
        cfg = None
        check("limiter config is valid JSON", False, str(exc))

if cfg is not None:
    print("PASS  limiter config is valid JSON")
    check("config sets a default cap",
          isinstance(cfg.get("default_minutes"), int) and cfg["default_minutes"] > 0,
          "default_minutes=%r" % cfg.get("default_minutes"))
    check("config has an exempt list", isinstance(cfg.get("exempt"), list))
    check("config has a per-player override map", isinstance(cfg.get("players"), dict))

# The script only runs because data/ is bind-mounted and KubeJS reads
# server_scripts/ from it. If that mount changes, the limiter silently stops.
with io.open(COMPOSE, encoding="utf-8") as fh:
    compose = fh.read()
check("data/ is bind-mounted so KubeJS can load the script",
      "./data:/data" in compose)

with io.open(GITIGNORE, encoding="utf-8") as fh:
    ignored = fh.read()
check("the limiter script is not gitignored",
      "data/kubejs/server_scripts/playtime_limit.js" not in ignored)

# The documentation tripwire. This is the part that actually prevents a repeat.
with io.open(DEPLOY, encoding="utf-8") as fh:
    deploy = fh.read()

# The correction deliberately QUOTES the old claim so a reader understands what
# changed, so a naive substring search would flag the fix as the defect. What
# must not come back is the claim asserted in the document's own voice, and the
# heading that framed it as current fact.
check("the old 'limits are NOT running' section is gone",
      "Daily playtime limits are NOT running" not in deploy)

stray = [
    line.strip()
    for line in deploy.splitlines()
    if "no time limit of any kind" in line and "previously said" not in line
]
check("DEPLOY.md never asserts there is no time limit in its own voice",
      not stray,
      "asserted at: %s" % (stray[:1] or ""))

check("DEPLOY.md carries the dated correction notice",
      "CORRECTION (2026-09-09)" in deploy)
check("DEPLOY.md documents how to verify the limiter is running",
      "grep playtime" in deploy,
      "the verification recipe is missing")
check("DEPLOY.md mentions the /playtime command",
      "/playtime" in deploy)

if failures:
    print("\n%d check(s) failed" % len(failures))
    sys.exit(1)

print("\nPlaytime limiter is present, wired, observable and honestly documented.")
print("NOTE: liveness is proved on the droplet with:")
print("  docker logs minecraft-java 2>&1 | grep playtime")
