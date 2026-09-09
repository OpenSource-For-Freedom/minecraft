#!/usr/bin/env bash
# Prove the CC:Tweaked HTTP lockdown is ACTUALLY IN FORCE on the running server.
#
# On the droplet:            bash tools/verify_cc_http.sh
# Against a local file:      CONFIG_FILE=/path/to/computercraft-server.toml bash tools/verify_cc_http.sh
#
# Why this exists as a separate step. tests/test_cc_http_lockdown.py runs in CI
# and proves the patch is present, wired and says the right thing. It cannot
# prove the patch APPLIED. The rules live in the per-world server config, which
# is gitignored and generated at runtime, so the only honest proof is reading the
# effective file after startup. A security control nobody verified is a belief,
# not a control.
#
# Format note, learned by testing against the pinned image: mc-image-helper
# rewrites TOML in a flattened form with single quotes
#   http.rules = [{host = '$private', action = 'deny'}, ...]
# rather than the pretty [[http.rules]] blocks CC:Tweaked ships. Both are valid
# TOML and Forge reads either, but it means grepping for `host = "*"` finds
# nothing and reports a false failure. So this parses the TOML properly instead.
set -euo pipefail

CONTAINER=${CONTAINER:-minecraft-java}
LEVEL=${LEVEL:-world}
CFG="/data/${LEVEL}/serverconfig/computercraft-server.toml"

if [ -n "${CONFIG_FILE:-}" ]; then
    [ -f "$CONFIG_FILE" ] || { echo "ABORT: $CONFIG_FILE not found" >&2; exit 2; }
    TOML=$(cat "$CONFIG_FILE")
    SOURCE="$CONFIG_FILE"
else
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
        echo "ABORT: container '$CONTAINER' is not running; start it and retry" >&2
        exit 2
    fi
    if ! docker exec "$CONTAINER" test -f "$CFG" 2>/dev/null; then
        echo "ABORT: $CFG does not exist inside the container." >&2
        echo "       Either the world has not generated yet, or LEVEL is not '$LEVEL'." >&2
        echo "       Check level-name in data/server.properties, then re-run with LEVEL=<name>." >&2
        exit 2
    fi
    TOML=$(docker exec "$CONTAINER" cat "$CFG")
    SOURCE="$CONTAINER:$CFG"
fi

command -v python3 >/dev/null 2>&1 || { echo "ABORT: python3 required" >&2; exit 2; }

echo "effective config: $SOURCE"
echo "---"

printf '%s\n' "$TOML" | python3 -c '
import sys
try:
    import tomllib
except ImportError:
    print("ABORT: python3.11+ needed for tomllib", file=sys.stderr); sys.exit(2)

raw = sys.stdin.buffer.read()
try:
    doc = tomllib.loads(raw.decode("utf-8"))
except Exception as exc:
    print("FAIL  effective config is not parseable TOML: %s" % exc); sys.exit(1)

http = doc.get("http")
if not isinstance(http, dict):
    print("FAIL  no [http] section in the effective config"); sys.exit(1)

fails = 0
def check(label, cond, detail=""):
    global fails
    if cond:
        print("PASS  %s" % label)
    else:
        print("FAIL  %s%s" % (label, (" - " + detail) if detail else ""))
        fails += 1

rules = http.get("rules")
check("http.rules is present", isinstance(rules, list) and bool(rules))
if not isinstance(rules, list) or not rules:
    sys.exit(1)

print("      %d rule(s):" % len(rules))
for i, r in enumerate(rules, 1):
    print("        %d. %-16s %s" % (i, r.get("host"), r.get("action")))

last = rules[-1]
check("the last rule is a catch-all deny",
      last.get("host") == "*" and last.get("action") == "deny",
      "last rule is %r; the lockdown did NOT apply and in-game computers can reach arbitrary hosts" % (last,))

required = ["$private", "169.254.0.0/16"]
denied = {r.get("host") for r in rules if r.get("action") == "deny"}
for want in required:
    check("denied: %s" % want, want in denied)

first_allow = next((i for i, r in enumerate(rules) if r.get("action") == "allow"), None)
if first_allow is None:
    print("PASS  no allow rules (fully closed)")
else:
    before = {r.get("host") for r in rules[:first_allow] if r.get("action") == "deny"}
    check("private ranges denied before the first allow",
          all(w in before for w in required),
          "an allow rule at index %d is evaluated before the private-range denies" % first_allow)
    for r in rules[:first_allow+1]:
        if r.get("action") == "allow":
            check("allow entry %r is a specific host" % r.get("host"),
                  isinstance(r.get("host"), str) and not r.get("host", "").startswith("*"))

check("websockets disabled", http.get("websocket_enabled") is False,
      "websocket_enabled=%r" % http.get("websocket_enabled"))
check("http API left enabled for readable denials", http.get("enabled") is True)

print("---")
if fails:
    print("%d problem(s). The lockdown is NOT in force." % fails)
    sys.exit(1)
print("CC:Tweaked HTTP lockdown is IN FORCE.")
print("")
print("Optional in-game proof: place a computer and run")
print("  print(http.checkURL(\"https://example.com\"))")
print("expected:  false   domain not permitted")
sys.exit(0)
'
rc=$?
if [ "$rc" -ne 0 ] && [ -z "${CONFIG_FILE:-}" ]; then
    echo ""
    echo "Check PATCH_DEFINITIONS is set in docker-compose.yml, that"
    echo "data/patches/computercraft-http.json reached the droplet, and read the"
    echo "startup log for a rejected definition:"
    echo "  docker logs $CONTAINER 2>&1 | grep -i 'patch\|mc-image-helper'"
fi
exit $rc
