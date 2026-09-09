#!/usr/bin/env python3
"""In-game computers must not be able to make the server call arbitrary hosts.

CC:Tweaked ships children a programmable computer with an HTTP API. Its stock
rules are `deny $private` followed by `allow *`, which means any whitelisted
player can write four lines of Lua and make THIS SERVER issue outbound requests
to anything on the internet. That is server-side request forgery, the attacker
is a nine-year-old, and it is reachable on the live server today.

The fix cannot be a committed config file. CC:Tweaked's HTTP rules are Forge
SERVER config, stored per-world at `world/serverconfig/computercraft-server.toml`,
and both `data/config/` and `data/world/` are gitignored deliberately: tracking
files the server rewrites leaves the droplet worktree permanently dirty and
makes `git pull --ff-only` in gitops/deploy.sh abort every run. So the rules are
applied at container start through itzg's PATCH_DEFINITIONS instead, which has
the useful property of re-asserting itself on every boot rather than being a
one-time edit somebody can undo by hand on the box.

WHAT THIS TEST IS NOT. It cannot prove the rules are live on the droplet. It
proves the patch is present, wired, and says the right thing. The only proof
that the control is actually in force is reading the effective TOML inside the
running container, which is what `tools/verify_cc_http.sh` does. Run that once
after the first deploy that carries this change, then treat this test as the
tripwire that stops the lockdown being loosened later without review.
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATCH_DIR = os.path.join(ROOT, "data", "patches")
PATCH_FILE = os.path.join(PATCH_DIR, "computercraft-http.json")
COMPOSE = os.path.join(ROOT, "docker-compose.yml")

# Everything CC:Tweaked must be refused. $private is CC:Tweaked's own matcher for
# loopback, RFC1918 and link-local. The CIDRs are belt-and-braces in case a
# future version drops $private, and 169.254.0.0/16 is the DigitalOcean metadata
# endpoint, which is the single most valuable SSRF target on this box.
REQUIRED_DENIES = {
    "$private",
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
}

failures = []


def check(label, condition, detail=""):
    if condition:
        print("PASS  %s" % label)
    else:
        print("FAIL  %s%s" % (label, (" - " + detail) if detail else ""))
        failures.append(label)


if not os.path.isfile(PATCH_FILE):
    print("FAIL  patch definition exists at data/patches/computercraft-http.json")
    sys.exit(1)

with io.open(PATCH_FILE, encoding="utf-8") as fh:
    try:
        doc = json.load(fh)
    except ValueError as exc:
        print("FAIL  patch definition is valid JSON - %s" % exc)
        sys.exit(1)

# Strict JSON on purpose. mc-image-helper advertises --json-allow-comments, but
# that applies to the files being PATCHED, not to the definition read from this
# directory: a // line here fails with "ALLOW_COMMENTS not enabled for parser"
# and the patch is silently skipped. Rationale lives in data/patches/README.md.
print("PASS  patch definition is strict JSON (no comments, which the loader rejects)")

# SHAPE. PATCH_DEFINITIONS points at a DIRECTORY, so every file in it must be a
# PatchDefinition ({"file", "ops"}). The {"patches": [...]} PatchSet wrapper is
# only valid when the env var names a single file, and using it here makes
# mc-image-helper reject the definition at startup with "Unrecognized field".
# The server then boots with stock permissive rules while CI stays green, which
# is the worst possible failure mode for a security control. Caught exactly this
# way by running the real patch tool against the pinned image before shipping.
check("definition is a PatchDefinition, not a PatchSet",
      "patches" not in doc,
      'a file in the patches directory must use {"file", "ops"}, not {"patches": [...]}')
check("definition declares a target file", "file" in doc)
check("definition declares ops", isinstance(doc.get("ops"), list) and bool(doc["ops"]))

patch = doc

# The path is the whole ballgame. Forge keeps CC:Tweaked's SERVER config inside
# the world folder, not in config/. Pointing this at /data/config/ would produce
# a patch that applies cleanly to nothing and a security fix that is a no-op.
check(
    "patch targets the per-world serverconfig, not config/",
    patch.get("file") == "/data/world/serverconfig/computercraft-server.toml",
    "got %r" % patch.get("file"),
)

ops = patch.get("ops") or []
sets = {}
for op in ops:
    body = op.get("$set")
    if body:
        sets[body.get("path")] = body.get("value")

check("http API stays enabled so denials give a readable error",
      sets.get("$.http.enabled") is True)
check("websockets are disabled", sets.get("$.http.websocket_enabled") is False)

rules = sets.get("$.http.rules")
check("patch replaces the whole http.rules list", isinstance(rules, list) and bool(rules))

if isinstance(rules, list) and rules:
    denied = {r.get("host") for r in rules if r.get("action") == "deny"}
    allowed = [r.get("host") for r in rules if r.get("action") == "allow"]

    missing = REQUIRED_DENIES - denied
    check("every private and metadata range is denied",
          not missing, "missing %s" % sorted(missing))

    # Order matters: CC:Tweaked takes the first matching rule. A wildcard allow
    # anywhere, or a catch-all that is not last and not a deny, reopens the hole.
    check("the last rule is a catch-all deny",
          rules[-1].get("host") == "*" and rules[-1].get("action") == "deny",
          "last rule is %r" % (rules[-1],))

    check("no rule allows the wildcard host",
          "*" not in allowed, "wildcard allow present")

    # An allow entry above the catch-all is legitimate and expected once the
    # Instructor Terminal lands, but it must be a specific host, never a wildcard
    # pattern that matches most of the internet.
    for host in allowed:
        check("allow entry %r is a specific host" % host,
              isinstance(host, str) and not host.startswith("*"),
              "wildcard allow entries defeat the allowlist")

    # Denies must precede the first allow, or a permissive entry wins first.
    first_allow = next((i for i, r in enumerate(rules) if r.get("action") == "allow"), None)
    if first_allow is not None:
        preceding = {r.get("host") for r in rules[:first_allow] if r.get("action") == "deny"}
        check("private ranges are denied before the first allow",
              not (REQUIRED_DENIES - preceding),
              "an allow rule is evaluated before the private-range denies")

with io.open(COMPOSE, encoding="utf-8") as fh:
    compose = fh.read()

# A perfect patch file that the container never reads is worth nothing.
check("compose wires PATCH_DEFINITIONS",
      'PATCH_DEFINITIONS: "/data/patches"' in compose)
check("the patch file lives in the wired directory",
      os.path.dirname(PATCH_FILE) == PATCH_DIR)

# data/patches must not be gitignored, or the droplet clones without it and the
# container starts with stock permissive rules while CI stays green.
with io.open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as fh:
    ignored = fh.read()
check("data/patches is not gitignored",
      "data/patches" not in ignored)

# The format rules above are invisible in the JSON itself, so they must be
# written down next to it or the next person repeats both mistakes.
check("data/patches/README.md documents the format traps",
      os.path.isfile(os.path.join(PATCH_DIR, "README.md")))

if failures:
    print("\n%d check(s) failed" % len(failures))
    sys.exit(1)

print("\nCC:Tweaked HTTP lockdown is present, wired and deny-by-default.")
print("NOTE: this does not prove it is live. Run tools/verify_cc_http.sh on the")
print("droplet after the first deploy carrying this change.")
