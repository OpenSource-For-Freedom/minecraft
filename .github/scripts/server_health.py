#!/usr/bin/env python3
"""EduCraft server health check, reported to Discord.

    python3 .github/scripts/server_health.py --host 159.65.25.218
    python3 .github/scripts/server_health.py --host ... --dry-run   # print, do not post

Deliberately uses NO SSH and NO credentials against the server.

That is a security decision, not a limitation. Port 22 on the droplet is open
only to DigitalOcean's console ranges (see specs/0004), so a GitHub-hosted
runner cannot reach it. The alternatives were to open 22 to GitHub's published
IP ranges, which is thousands of addresses belonging to a third party, or to
put a long-lived SSH credential into CI where every workflow and every fork PR
becomes a path to the box. Both are worse than having slightly less detail in a
health report.

Everything below is obtained from the SAME public interface a player uses, so a
green result means what an owner actually cares about: players can get in.

Standard library only. No pip install in a workflow that will run unattended
for months.
"""
import argparse
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

PROTOCOL = 763  # 1.20.1


# ---------------------------------------------------------------- minecraft
def _varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += struct.pack("B", b | (0x80 if n else 0))
        if not n:
            return out


def _read_varint(sock):
    n = 0
    for i in range(5):
        d = sock.recv(1)
        if not d:
            raise EOFError("server closed the connection")
        b = d[0]
        n |= (b & 0x7F) << (7 * i)
        if not b & 0x80:
            return n
    raise IOError("varint too long")


def ping(host, port, timeout):
    """One Server List Ping. Returns (status_dict, latency_ms)."""
    t0 = time.time()
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        h = host.encode()
        hs = b"\x00" + _varint(PROTOCOL) + _varint(len(h)) + h + struct.pack(">H", port) + _varint(1)
        sock.sendall(_varint(len(hs)) + hs)
        sock.sendall(_varint(1) + b"\x00")
        _read_varint(sock)          # packet length
        _read_varint(sock)          # packet id
        n = _read_varint(sock)      # json length
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(min(4096, n - len(buf)))
            if not chunk:
                raise EOFError("closed mid-payload")
            buf += chunk
        return json.loads(buf.decode("utf-8")), int((time.time() - t0) * 1000)
    finally:
        sock.close()


def ping_with_retries(host, port, attempts, timeout, gap):
    """Retry, because a single timeout is not an outage.

    This server has shown roughly 3-in-4 TCP loss from some networks while
    remaining perfectly healthy, so a one-shot check would page constantly and
    train everyone to ignore it. Report the ratio instead: it is a better signal
    than a boolean, and it distinguishes "down" from "reachable but lossy".
    """
    ok, last_err, result, best = 0, None, None, None
    for i in range(attempts):
        try:
            data, ms = ping(host, port, timeout)
            ok += 1
            result = data
            best = ms if best is None else min(best, ms)
        except Exception as e:                       # noqa: BLE001 - report any failure
            last_err = f"{type(e).__name__}: {e}"
        if i < attempts - 1:
            time.sleep(gap)
    return result, ok, attempts, best, last_err


def describe(data):
    d = data.get("description")
    if isinstance(d, dict):
        d = (d.get("text") or "") + "".join(x.get("text", "") for x in d.get("extra", []))
    text = " ".join(str(d or "").split())
    # Strip Minecraft colour codes (section sign + one char). Left in, they show
    # up in Discord as literal mojibake like "EduCraft §7Education".
    return re.sub(r"§.", "", text)


# ---------------------------------------------------------------- deployment
def last_deployment(repo, token):
    """Most recent deployment state, so a red health check can be tied to a deploy."""
    if not token:
        return None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/deployments?per_page=1",
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "educraft-health"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            deps = json.loads(r.read().decode())
        if not deps:
            return None
        dep = deps[0]
        req2 = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/deployments/{dep['id']}/statuses?per_page=1",
            headers={"Authorization": f"Bearer {token}",
                     "Accept": "application/vnd.github+json",
                     "User-Agent": "educraft-health"})
        with urllib.request.urlopen(req2, timeout=20) as r:
            st = json.loads(r.read().decode())
        return {"sha": (dep.get("sha") or "")[:8],
                "state": st[0]["state"] if st else "unknown",
                "created": dep.get("created_at", "")}
    except Exception:                                # noqa: BLE001 - health must not fail on this
        return None


# ---------------------------------------------------------------- discord
def post(webhook, payload, dry):
    if dry or not webhook:
        print(json.dumps(payload, indent=2))
        return True
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        webhook, data=body,
        headers={"Content-Type": "application/json", "User-Agent": "educraft-health"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status in (200, 204)
    except urllib.error.HTTPError as e:
        # Never print the webhook URL: the URL IS the credential, and anyone
        # holding it can post to the channel.
        print(f"discord rejected the post: HTTP {e.code}", file=sys.stderr)
        return False
    except Exception as e:                           # noqa: BLE001
        print(f"discord post failed: {type(e).__name__}", file=sys.stderr)
        return False


def build(host, port, data, ok, total, ms, err, dep, show_names):
    up = data is not None
    lossy = up and ok < total
    colour = 0x446937 if (up and not lossy) else (0xA9772E if up else 0xA8433B)
    title = "EduCraft is up" if (up and not lossy) else (
        "EduCraft is up but lossy" if up else "EduCraft is NOT reachable")

    fields = [{"name": "Reachability", "value": f"{ok}/{total} pings succeeded", "inline": True}]
    if up:
        players = data.get("players", {}) or {}
        version = (data.get("version", {}) or {}).get("name", "unknown")
        fields += [
            {"name": "Latency", "value": f"{ms} ms", "inline": True},
            {"name": "Version", "value": str(version), "inline": True},
            {"name": "Players", "value": f"{players.get('online', '?')} / {players.get('max', '?')}",
             "inline": True},
        ]
        # Player NAMES are opt-in. A webhook URL is a bearer credential; if it
        # ever leaks, anything posted through it leaks with it. On a server whose
        # players are children, usernames are not worth that risk by default.
        if show_names and players.get("sample"):
            names = ", ".join(p.get("name", "?") for p in players["sample"])
            fields.append({"name": "Online", "value": names[:1000], "inline": False})
        motd = describe(data)
        if motd:
            fields.append({"name": "MOTD", "value": motd[:200], "inline": False})
        fd = data.get("forgeData") or {}
        if fd:
            fields.append({"name": "Modded", "value": f"Forge (fml {fd.get('fmlNetworkVersion','?')})",
                           "inline": True})
    else:
        fields.append({"name": "Last error", "value": f"`{(err or 'unknown')[:200]}`", "inline": False})

    if dep:
        fields.append({"name": "Last deploy",
                       "value": f"`{dep['sha']}` {dep['state']}", "inline": True})

    return {"embeds": [{
        "title": title,
        "description": f"`{host}:{port}`",
        "color": colour,
        "fields": fields,
        "footer": {"text": "EduCraft health check"},
    }]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=25565)
    ap.add_argument("--attempts", type=int, default=4)
    ap.add_argument("--timeout", type=float, default=8.0)
    ap.add_argument("--gap", type=float, default=3.0)
    ap.add_argument("--show-names", action="store_true",
                    help="include online player names (off by default; see build())")
    ap.add_argument("--always-post", action="store_true",
                    help="post even when fully healthy (default: only on trouble)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    data, ok, total, ms, err = ping_with_retries(a.host, a.port, a.attempts, a.timeout, a.gap)
    dep = last_deployment(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GH_API_TOKEN"))

    healthy = data is not None and ok == total
    state = "UP" if data else "DOWN"
    print(f"host={a.host}:{a.port} state={state} pings={ok}/{total} latency={ms}ms")
    if err:
        print(f"last error: {err}")

    if healthy and not a.always_post:
        print("healthy and --always-post not set: not posting to Discord")
        return 0

    payload = build(a.host, a.port, data, ok, total, ms, err, dep, a.show_names)
    posted = post(os.environ.get("DISCORD_WEBHOOK"), payload, a.dry_run)

    # Exit non-zero only when the server is genuinely unreachable. Partial loss
    # is reported but does not fail the workflow, or the run history becomes red
    # noise that nobody reads.
    if data is None:
        return 1
    return 0 if posted else 0


if __name__ == "__main__":
    sys.exit(main())
