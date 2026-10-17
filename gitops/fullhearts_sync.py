#!/usr/bin/env python3
"""Keep the whitelist in step with paid EduCraft families on fullhearts.app.

Run by fullhearts-sync.timer every 2 minutes. Each run:

    pull the wanted list from FullHearts -> compare with data/whitelist.json
    -> add / remove ONLY players this script added itself -> report back

THE ONE RULE: never touch a player this script did not add. Anyone put on the
whitelist by hand (WHITELIST in compose, /whitelist in game, rcon-cli) stays
exactly as they are. The script keeps its own ledger of what it added
(/var/lib/educraft-sync/ledger.json) and only ever removes entries found there.

Why pull and not push: the droplet keeps its no-inbound, no-RCON-exposed
design. The only secret here is a token that can read one realm's list of
website-managed usernames and post a report. It cannot change anything on
FullHearts and cannot reach this box.

Fails safe in every direction that matters:
  - FullHearts down, slow, wrong token, or a reply that doesn't validate:
    change nothing. A kid who should be removed stays a little longer; nobody
    who is playing gets kicked by mistake.
  - The site says "paused": change nothing. An empty list is never read as
    "remove everyone".
  - More than REMOVAL_ALARM removals wanted at once: remove nobody, alert.
    Below that, at most MAX_REMOVALS_PER_RUN go per run and the rest wait
    for the next run, so a family cancelling three kids still gets removed.
  - Someone removed a script-added player by hand: respect it, never re-add
    while they stay on the wanted list.
  - SYNC_MODE=dryrun (the default): only report what it would do.

Standard library only, like world_info.py. Usernames reach rcon-cli as their
own argv element, never through a shell, and must match Minecraft's own
username pattern first.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

NAME_RE = re.compile(r"^[A-Za-z0-9_]{3,16}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SCHEMA = 1
MAX_ENTRIES = 500


class Invalid(Exception):
    """The wanted list failed validation. Nothing may be changed on its say-so."""


def env(name, default=None):
    value = os.environ.get(name, default)
    return value.strip() if isinstance(value, str) else value


def parse_wanted(raw, expect_realm=None):
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        raise Invalid("unknown schema")
    mode = raw.get("mode")
    if mode not in ("apply", "paused"):
        raise Invalid("unknown mode")
    if expect_realm is not None and raw.get("realm_id") != expect_realm:
        raise Invalid("list is for a different realm")
    entries = raw.get("entries")
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise Invalid("entries missing or too long")
    wanted = {}
    for e in entries:
        if not isinstance(e, dict):
            raise Invalid("entry is not an object")
        uuid = str(e.get("uuid", "")).lower()
        name = str(e.get("name", ""))
        if not UUID_RE.match(uuid) or not NAME_RE.match(name):
            raise Invalid("bad entry")
        wanted[uuid] = name
    return mode, wanted


def read_json_list(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    out = {}
    for e in data if isinstance(data, list) else []:
        if isinstance(e, dict) and isinstance(e.get("uuid"), str):
            out[e["uuid"].lower()] = str(e.get("name", ""))
    return out


def empty_ledger():
    # added:   uuid -> name, players THIS script put on the whitelist
    # blocked: uuids someone removed by hand after we added them; not re-added
    #          until they drop off the wanted list
    # seen_preexisting: wanted uuids that were already whitelisted by hand
    return {"added": {}, "blocked": [], "seen_preexisting": []}


def load_ledger(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return empty_ledger()
    ledger = empty_ledger()
    ledger["added"] = {k.lower(): v for k, v in data.get("added", {}).items() if UUID_RE.match(k.lower())}
    ledger["blocked"] = [u for u in data.get("blocked", []) if UUID_RE.match(u)]
    ledger["seen_preexisting"] = [u for u in data.get("seen_preexisting", []) if UUID_RE.match(u)]
    return ledger


def save_ledger(path, ledger):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ledger, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def plan(wanted, whitelist, banned, ledger, max_removals, removal_alarm=5):
    """Pure decision step. Nothing outside the script's own ledger is ever removed."""
    added = ledger["added"]
    blocked = set(ledger["blocked"])
    p = {
        "add": {}, "remove": {}, "present": [], "preexisting": [],
        "removed_by_others": [], "forget": [], "unblock": [], "errors": [],
        "removals_blocked": False, "deferred": [],
    }

    for uuid, name in sorted(wanted.items()):
        if uuid in whitelist:
            if uuid in added:
                p["present"].append(uuid)
            else:
                # On the list, but not by us: someone added them by hand. Theirs, forever.
                p["preexisting"].append(uuid)
        elif uuid in added:
            # We added them, they're gone, and nobody told us: a person removed them.
            p["removed_by_others"].append(uuid)
        elif uuid in blocked:
            p["removed_by_others"].append(uuid)
        elif uuid in banned:
            p["errors"].append({"uuid": uuid, "message": "player is banned on the server; not added"})
        else:
            p["add"][uuid] = name

    for uuid, name in sorted(added.items()):
        if uuid in wanted:
            continue
        if uuid in whitelist:
            p["remove"][uuid] = whitelist[uuid] or name
        else:
            p["forget"].append(uuid)

    # Someone who left the wanted list can be added again later if they come back.
    p["unblock"] = [u for u in blocked if u not in wanted]

    if len(p["remove"]) > removal_alarm:
        p["removals_blocked"] = True
        p["errors"].append({"message": f"{len(p['remove'])} removals wanted, alarm is {removal_alarm}; removed nobody"})
        p["remove"] = {}
    elif len(p["remove"]) > max_removals:
        now = sorted(p["remove"])[:max_removals]
        p["deferred"] = sorted(u for u in p["remove"] if u not in now)
        p["remove"] = {u: p["remove"][u] for u in now}
    return p


def rcon(container, *args):
    for a in args:
        if not re.match(r"^[A-Za-z0-9_]+$", a):
            raise ValueError("refusing an rcon argument outside [A-Za-z0-9_]")
    return subprocess.run(
        ["docker", "exec", "-i", container, "rcon-cli", *args],
        capture_output=True, text=True, timeout=30, check=False,
    )


def container_running(container):
    r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", container],
                       capture_output=True, text=True, timeout=15, check=False)
    return r.returncode == 0 and r.stdout.strip() == "true"


def wait_for(path, predicate, tries=10):
    for _ in range(tries):
        if predicate(read_json_list(path)):
            return True
        time.sleep(0.5)
    return False


def apply_plan(p, ledger, cfg, rcon_fn=rcon):
    """Carry out a plan, saving the ledger after every change so a crash can't orphan an entry."""
    wl_path = cfg["whitelist_path"]
    errors = list(p["errors"])
    done_add, done_remove = [], []

    for uuid in p["forget"]:
        ledger["added"].pop(uuid, None)
    for uuid in p["removed_by_others"]:
        ledger["added"].pop(uuid, None)
        if uuid not in ledger["blocked"]:
            ledger["blocked"].append(uuid)
    ledger["blocked"] = [u for u in ledger["blocked"] if u not in set(p["unblock"])]
    seen = set(ledger["seen_preexisting"]) | set(p["preexisting"])
    ledger["seen_preexisting"] = sorted(seen)
    save_ledger(cfg["ledger_path"], ledger)

    for uuid, name in p["add"].items():
        rcon_fn(cfg["container"], "whitelist", "add", name)
        if wait_for(wl_path, lambda wl, u=uuid: u in wl):
            ledger["added"][uuid] = name
            save_ledger(cfg["ledger_path"], ledger)
            done_add.append(uuid)
            continue
        # The name resolved to a different account (renamed since the site
        # checked it). Undo it, but only if that entry is new: never remove an
        # account that was already on the list before this run.
        before = cfg.get("before", {})
        now = read_json_list(wl_path)
        if any(n.lower() == name.lower() and u not in before and u not in ledger["added"] for u, n in now.items()):
            rcon_fn(cfg["container"], "whitelist", "remove", name)
        errors.append({"uuid": uuid, "message": f"adding {name} did not whitelist the expected account; undone"})

    for uuid, name in p["remove"].items():
        rcon_fn(cfg["container"], "whitelist", "remove", name)
        if wait_for(wl_path, lambda wl, u=uuid: u not in wl):
            ledger["added"].pop(uuid, None)
            save_ledger(cfg["ledger_path"], ledger)
            done_remove.append(uuid)
        else:
            errors.append({"uuid": uuid, "message": f"removing {name} did not take effect"})

    return done_add, done_remove, errors


def fetch_wanted(base, token, timeout=15):
    req = urllib.request.Request(
        base.rstrip("/") + "/api/sync/v1/whitelist/",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "educraft-sync/1"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise Invalid(f"HTTP {r.status}")
        body = r.read(1_000_000)
    return json.loads(body)


def post_report(base, token, report, timeout=15):
    data = json.dumps(report).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/api/sync/v1/report/", data=data, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "educraft-sync/1"},
    )
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
    except (urllib.error.URLError, OSError) as e:
        print(f"report not delivered: {e}", file=sys.stderr)


def discord_alert(text):
    """Problems only, through the existing alert webhook if installed. Routine runs stay silent."""
    hook = env("DISCORD_WEBHOOK")
    if not hook or not hook.startswith(("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/")):
        return
    req = urllib.request.Request(hook, data=json.dumps({"content": f"[educraft-sync] {text}"[:1900]}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "educraft-sync/1"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except (urllib.error.URLError, OSError):
        pass


def main():
    cfg = {
        "base": env("FULLHEARTS_SYNC_URL", "https://fullhearts.app"),
        "token": env("FULLHEARTS_SYNC_TOKEN", ""),
        "mode": env("SYNC_MODE", "dryrun"),
        "container": env("MC_CONTAINER", "minecraft-java"),
        "whitelist_path": os.path.join(env("MC_DATA", "/root/minecraft/data"), "whitelist.json"),
        "banned_path": os.path.join(env("MC_DATA", "/root/minecraft/data"), "banned-players.json"),
        "ledger_path": env("LEDGER", "/var/lib/educraft-sync/ledger.json"),
        "max_removals": int(env("MAX_REMOVALS_PER_RUN", "2")),
        "removal_alarm": int(env("REMOVAL_ALARM", "5")),
        "realm_id": int(env("REALM_ID")) if env("REALM_ID") else None,
    }
    if not cfg["token"]:
        print("FULLHEARTS_SYNC_TOKEN is not set; nothing to do", file=sys.stderr)
        return 1
    if cfg["mode"] not in ("dryrun", "apply"):
        print("SYNC_MODE must be dryrun or apply", file=sys.stderr)
        return 1

    lock = open(env("LOCK_PATH", "/run/educraft-sync.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0

    try:
        mode, wanted = parse_wanted(fetch_wanted(cfg["base"], cfg["token"]), cfg["realm_id"])
    except urllib.error.HTTPError as e:
        if e.code == 401:
            discord_alert("FullHearts rejected the sync token. Nothing changed. Replace it in /etc/educraft-sync.env.")
        print(f"could not fetch the wanted list (HTTP {e.code}); changed nothing", file=sys.stderr)
        return 0
    except (urllib.error.URLError, OSError, ValueError, Invalid) as e:
        print(f"could not fetch a valid wanted list ({e}); changed nothing", file=sys.stderr)
        return 0

    if mode == "paused":
        print("FullHearts says paused; changed nothing")
        return 0
    if not container_running(cfg["container"]):
        print("server container is not running; changed nothing", file=sys.stderr)
        return 0

    whitelist = read_json_list(cfg["whitelist_path"])
    banned = read_json_list(cfg["banned_path"])
    ledger = load_ledger(cfg["ledger_path"])
    p = plan(wanted, whitelist, banned, ledger, cfg["max_removals"], cfg["removal_alarm"])

    dry = cfg["mode"] != "apply"
    if dry:
        added, removed, errors = list(p["add"]), list(p["remove"]), p["errors"]
    else:
        cfg["before"] = whitelist
        added, removed, errors = apply_plan(p, ledger, cfg)

    if p["removals_blocked"]:
        discord_alert(f"{errors[-1]['message'] if errors else 'too many removals'}. Check the FullHearts admin page.")

    post_report(cfg["base"], cfg["token"], {
        "schema": SCHEMA,
        "dry_run": dry,
        "present": p["present"],
        "added": added,
        "removed": removed,
        "preexisting": p["preexisting"],
        "removed_by_others": p["removed_by_others"],
        "errors": errors,
    })
    print(f"{'dry run: would add' if dry else 'added'} {len(added)}, "
          f"{'would remove' if dry else 'removed'} {len(removed)}, {len(p['deferred'])} removals held for next run, "
          f"{len(p['present'])} present, {len(p['preexisting'])} hand-added left alone, {len(errors)} errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
