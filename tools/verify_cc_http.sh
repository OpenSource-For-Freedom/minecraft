#!/usr/bin/env bash
# Prove the CC:Tweaked HTTP lockdown is ACTUALLY IN FORCE on the running server.
#
# Run this on the droplet after the first deploy that carries the lockdown:
#     bash tools/verify_cc_http.sh
#
# Why this exists as a separate step. tests/test_cc_http_lockdown.py runs in CI
# and proves the patch is present, wired and says the right thing. It cannot
# prove the patch APPLIED. The rules live in the per-world server config, which
# is gitignored and generated at runtime, so the only honest proof is reading the
# effective file inside the container after startup. A security control nobody
# verified is a belief, not a control.
#
# Exits non-zero and prints what is wrong if the lockdown is not in force.
set -euo pipefail

CONTAINER=${CONTAINER:-minecraft-java}
LEVEL=${LEVEL:-world}
CFG="/data/${LEVEL}/serverconfig/computercraft-server.toml"

fail=0
note() { echo "$*"; }
bad()  { echo "FAIL  $*"; fail=$((fail + 1)); }
ok()   { echo "PASS  $*"; }

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    echo "ABORT: container '$CONTAINER' is not running; start it and retry" >&2
    exit 2
fi

if ! docker exec "$CONTAINER" test -f "$CFG" 2>/dev/null; then
    echo "ABORT: $CFG does not exist inside the container." >&2
    echo "       Either CC:Tweaked has not generated it yet (start the server once" >&2
    echo "       and let the world load), or LEVEL is not '$LEVEL'. Check the" >&2
    echo "       level-name in data/server.properties and re-run with LEVEL=<name>." >&2
    exit 2
fi

TOML=$(docker exec "$CONTAINER" cat "$CFG")

note "effective config: $CFG"
note "---"

# Extract just the [http] section so a 'deny' somewhere else in the file cannot
# be mistaken for the rules we care about.
HTTP_SECTION=$(printf '%s\n' "$TOML" | awk '/^\[http\]/{f=1} f{print} /^\[[a-z_]+\]$/ && !/^\[http\]/ && f && ++n>1{exit}')

if [ -z "$HTTP_SECTION" ]; then
    bad "no [http] section found in the effective config"
    HTTP_SECTION="$TOML"
fi

# The stock CC:Tweaked config ends with an 'allow *' rule. If that survived, the
# patch did not apply and in-game computers can still reach the whole internet.
if printf '%s\n' "$HTTP_SECTION" | grep -qE '^[[:space:]]*host[[:space:]]*=[[:space:]]*"\*"' ; then
    # A wildcard host entry exists. It is only safe if its action is deny.
    wildcard_action=$(printf '%s\n' "$HTTP_SECTION" \
        | grep -A3 -E '^[[:space:]]*host[[:space:]]*=[[:space:]]*"\*"' \
        | grep -m1 -oE 'action[[:space:]]*=[[:space:]]*"[a-z]+"' \
        | grep -oE '"[a-z]+"' | tr -d '"' || true)
    if [ "${wildcard_action:-}" = "deny" ]; then
        ok "wildcard host rule is deny"
    else
        bad "wildcard host rule action is '${wildcard_action:-unknown}', expected deny"
        bad "  the lockdown did NOT apply: in-game computers can reach arbitrary hosts"
    fi
else
    bad "no wildcard host rule found; cannot confirm a catch-all deny is present"
fi

for range in '\$private' '169\.254\.0\.0/16'; do
    if printf '%s\n' "$HTTP_SECTION" | grep -qE "host[[:space:]]*=[[:space:]]*\"${range}\""; then
        ok "denied range present: $(printf '%s' "$range" | tr -d '\\')"
    else
        bad "missing denied range: $(printf '%s' "$range" | tr -d '\\')"
    fi
done

if printf '%s\n' "$HTTP_SECTION" | grep -qE '^[[:space:]]*websocket_enabled[[:space:]]*=[[:space:]]*false'; then
    ok "websockets disabled"
else
    bad "websocket_enabled is not false"
fi

note "---"
if [ "$fail" -eq 0 ]; then
    note "CC:Tweaked HTTP lockdown is IN FORCE on the running server."
    note ""
    note "Optional live proof, if you want to see it refuse from inside the game:"
    note "  place a computer, then run:  print(http.checkURL('https://example.com'))"
    note "  expected output:             false   domain not permitted"
    exit 0
fi

note "$fail problem(s). The lockdown is NOT in force."
note "Check that PATCH_DEFINITIONS is set in docker-compose.yml, that"
note "data/patches/computercraft-http.json reached the droplet, and read the"
note "container log for patch errors:  docker logs $CONTAINER 2>&1 | grep -i patch"
exit 1
