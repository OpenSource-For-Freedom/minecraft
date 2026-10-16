#!/usr/bin/env python3
"""gitops/fullhearts_sync.py must never touch a player it did not add.

The script edits the live whitelist from a list another system sends it, so
every check here is about what it must NOT do:

1. Hand-added players (compose WHITELIST, /whitelist, rcon-cli) are never
   removed, even when they are missing from the wanted list.
2. A player already whitelisted by hand who is also on the wanted list is
   recorded as pre-existing and still never removed later.
3. More removals than the alarm removes nobody; fewer go a few per run.
4. A reply that is paused, malformed, for another realm, or carries a name
   that isn't a Minecraft username, changes nothing.
5. A player someone removed by hand is not added back behind their back.
6. A name that resolves to a different account is undone, and only if that
   entry is new.
7. compose never turns on OVERRIDE_WHITELIST, which would rewrite the live
   whitelist from compose on every deploy and wipe every site-added player.
8. Dry run is the default.
"""
import json
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "gitops"))
import fullhearts_sync as fs  # noqa: E402

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)


def u(n):
    return f"{n:08x}-0000-0000-0000-000000000000"


HAND = u(1)       # added by the owner, never ours
KID_A = u(2)
KID_B = u(3)
KID_C = u(4)


def ledger(added=None, blocked=None):
    lg = fs.empty_ledger()
    lg["added"] = dict(added or {})
    lg["blocked"] = list(blocked or [])
    return lg


# 1. a hand-added player missing from the wanted list stays
p = fs.plan(wanted={}, whitelist={HAND: "Owner"}, banned={}, ledger=ledger(), max_removals=2)
check(not p["remove"], "removed a hand-added player who was never in the ledger")

# 2. hand-added AND wanted: pre-existing, and later still not removable
p = fs.plan(wanted={HAND: "Owner"}, whitelist={HAND: "Owner"}, banned={}, ledger=ledger(), max_removals=2)
check(p["preexisting"] == [HAND] and not p["add"], "hand-added wanted player not treated as pre-existing")
p = fs.plan(wanted={}, whitelist={HAND: "Owner"}, banned={}, ledger=ledger(), max_removals=2)
check(HAND not in p["remove"], "pre-existing player removed once they left the wanted list")

# normal add / keep / remove of our own entries
p = fs.plan(wanted={KID_A: "KidA", KID_B: "KidB"}, whitelist={KID_B: "KidB", KID_C: "KidC"},
            banned={}, ledger=ledger(added={KID_B: "KidB", KID_C: "KidC"}), max_removals=2)
check(p["add"] == {KID_A: "KidA"}, "did not add a wanted, missing player")
check(p["present"] == [KID_B], "did not report our present player")
check(p["remove"] == {KID_C: "KidC"}, "did not remove our own unwanted player")

# 3. removal limit: a family of three leaves over two runs, a mass removal is refused
three = {KID_A: "A", KID_B: "B", KID_C: "C"}
p = fs.plan(wanted={}, whitelist=dict(three), banned={}, ledger=ledger(added=dict(three)), max_removals=2)
check(len(p["remove"]) == 2 and not p["removals_blocked"], "did not remove two of three leaving players")
check(p["deferred"] == sorted(set(three) - set(p["remove"])), "did not hold the third removal for the next run")
left = {u: n for u, n in three.items() if u not in p["remove"]}
p = fs.plan(wanted={}, whitelist=left, banned={}, ledger=ledger(added=dict(left)), max_removals=2)
check(list(p["remove"]) == list(left) and not p["deferred"], "did not remove the held player on the next run")
many = {f"{i:08x}-0000-4000-8000-000000000000": f"P{i}" for i in range(6)}
p = fs.plan(wanted={}, whitelist=dict(many), banned={}, ledger=ledger(added=dict(many)), max_removals=2)
check(p["remove"] == {} and p["removals_blocked"], "removed players when more than the alarm wanted out")

# 4. bad replies change nothing
for bad in (
    {"schema": 2, "mode": "apply", "entries": []},
    {"schema": 1, "mode": "wipe", "entries": []},
    {"schema": 1, "mode": "apply", "entries": "nope"},
    {"schema": 1, "mode": "apply", "entries": [{"uuid": KID_A, "name": "x; op Evil"}]},
    {"schema": 1, "mode": "apply", "entries": [{"uuid": "not-a-uuid", "name": "Fine"}]},
):
    try:
        fs.parse_wanted(bad)
        FAILS.append(f"accepted an invalid reply: {bad}")
    except fs.Invalid:
        pass
try:
    fs.parse_wanted({"schema": 1, "mode": "apply", "realm_id": 2, "entries": []}, expect_realm=1)
    FAILS.append("accepted a list for another realm")
except fs.Invalid:
    pass
mode, wanted = fs.parse_wanted({"schema": 1, "mode": "paused", "entries": []})
check(mode == "paused", "paused mode not recognised")
try:
    fs.rcon("minecraft-java", "whitelist", "add", "bad name")
    FAILS.append("rcon accepted an argument with a space")
except ValueError:
    pass

# 5. removed by hand: not re-added, and re-allowed once off the wanted list
p = fs.plan(wanted={KID_A: "KidA"}, whitelist={}, banned={}, ledger=ledger(added={KID_A: "KidA"}), max_removals=2)
check(not p["add"] and p["removed_by_others"] == [KID_A], "re-added a player someone removed by hand")
p = fs.plan(wanted={KID_A: "KidA"}, whitelist={}, banned={}, ledger=ledger(blocked=[KID_A]), max_removals=2)
check(not p["add"], "re-added a blocked player")
p = fs.plan(wanted={}, whitelist={}, banned={}, ledger=ledger(blocked=[KID_A]), max_removals=2)
check(p["unblock"] == [KID_A], "did not unblock a player who left the wanted list")

# banned players are reported, not added
p = fs.plan(wanted={KID_A: "KidA"}, whitelist={}, banned={KID_A: "KidA"}, ledger=ledger(), max_removals=2)
check(not p["add"] and p["errors"], "added a banned player")

# 6. apply against a real file with a fake rcon
with tempfile.TemporaryDirectory() as d:
    wl = os.path.join(d, "whitelist.json")
    cfg = {"container": "c", "whitelist_path": wl, "ledger_path": os.path.join(d, "l", "ledger.json")}

    def write(entries):
        with open(wl, "w") as f:
            json.dump([{"uuid": k, "name": v} for k, v in entries.items()], f)

    state = {HAND: "Owner"}
    write(state)
    cfg["before"] = dict(state)

    def fake_rcon(_container, _cmd, action, name):
        if action == "add":
            # "Renamed" resolves to a different account than the site expected.
            state[KID_C if name == "Renamed" else KID_A] = name
        else:
            for k in [k for k, v in state.items() if v == name]:
                del state[k]
        write(state)

    fs.wait_for.__defaults__ = (1,)
    lg = ledger()
    p = fs.plan(wanted={KID_A: "KidA", KID_B: "Renamed"}, whitelist=dict(state), banned={}, ledger=lg, max_removals=2)
    added, removed, errors = fs.apply_plan(p, lg, cfg, rcon_fn=fake_rcon)
    check(added == [KID_A], "a confirmed add was not recorded")
    check(KID_A in lg["added"] and KID_B not in lg["added"], "ledger wrong after adds")
    check(KID_C not in state, "a wrong-account add was not undone")
    check(HAND in state, "the hand-added player disappeared")
    check(any("did not whitelist the expected account" in e["message"] for e in errors), "wrong-account add not reported")
    with open(cfg["ledger_path"]) as f:
        check(KID_A in json.load(f)["added"], "ledger not written to disk")

# 7. OVERRIDE_WHITELIST must never be on
with open(os.path.join(ROOT, "docker-compose.yml")) as f:
    compose = f.read()
check(not re.search(r'^\s*OVERRIDE_WHITELIST\s*:\s*"?(true|TRUE|True|1)"?', compose, re.M),
      "docker-compose.yml sets OVERRIDE_WHITELIST; every deploy would wipe site-added players")

# 8. dry run by default
with open(os.path.join(ROOT, "gitops", "fullhearts_sync.py")) as f:
    check('env("SYNC_MODE", "dryrun")' in f.read(), "SYNC_MODE no longer defaults to dryrun")

if FAILS:
    for msg in FAILS:
        print(f"FAIL: {msg}")
    sys.exit(1)
print("fullhearts_sync: all checks passed")
