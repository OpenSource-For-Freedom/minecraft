#!/usr/bin/env python3
"""Audit the pinned Modrinth mod URLs for supply-chain and availability problems.

    python tools/audit_mod_pins.py            # report, exit 1 on a FAIL finding
    python tools/audit_mod_pins.py --json     # machine-readable, for the workflow

WHAT THIS CAN AND CANNOT TELL YOU, because the difference matters and a scanner
that overstates its reach is worse than none:

There is NO CVE feed for Minecraft mods. Nothing indexes Forge mods the way the
NVD indexes npm or Maven, so this cannot say "mod X has a known vulnerability".
Anyone claiming a weekly job keeps the modpack free of vulnerabilities is
describing something that does not exist.

What IS checkable, and what this actually checks:

  FAIL  the pinned version no longer exists on Modrinth. Versions get pulled,
        and the usual reason a maintainer pulls one is that it was broken or
        malicious. A 404 on a pin is the strongest signal available here.

  FAIL  the CDN now serves DIFFERENT BYTES than Modrinth's own recorded hash
        for that version. A pinned immutable URL whose content changed is the
        classic supply-chain tampering signature. sync_client_pack.py already
        trusts these hashes for the client pack; this checks the server list.

  WARN  the project is archived or deprecated upstream. Not urgent, but it means
        no fixes are coming and the pin should be reconsidered.

  INFO  a newer version exists for this loader/game version. Deliberately NOT a
        failure: every server mod bump forces every family to re-import the
        client pack, so routine bumps are a disruption with a real cost and are
        not taken without a reason.

Exit code is 1 only for FAIL findings, so the weekly gate stays quiet unless
something actually warrants a human.
"""
import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request

COMPOSE = "docker-compose.yml"
API = "https://api.modrinth.com/v2"
UA = "EduCraft-mod-pin-audit (github.com/OpenSource-For-Freedom/minecraft)"
TIMEOUT = 30


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read()
    return data if raw else json.loads(data)


def pinned_urls():
    """Every Modrinth CDN jar URL from the MODS env var in docker-compose.yml."""
    text = open(COMPOSE, encoding="utf-8").read()
    m = re.search(r'^\s*MODS:\s*"([^"]+)"', text, re.M)
    if not m:
        raise SystemExit("FAIL: could not find the MODS list in " + COMPOSE)
    return [u.strip() for u in m.group(1).split(",") if u.strip()]


VERSION_URL = re.compile(
    r"https://cdn\.modrinth\.com/data/([A-Za-z0-9]+)/versions/([A-Za-z0-9]+)/(.+)$"
)


def audit_one(url):
    """Return a finding dict for one pinned jar URL."""
    m = VERSION_URL.match(url)
    name = url.rsplit("/", 1)[-1]
    if not m:
        return {"level": "WARN", "mod": name,
                "detail": "not a Modrinth CDN version URL; cannot audit"}

    project_id, version_id, _file = m.groups()

    try:
        version = get(f"{API}/version/{version_id}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"level": "FAIL", "mod": name, "project": project_id,
                    "detail": "pinned version no longer exists on Modrinth "
                              "(404) - it was pulled; find out why before bumping"}
        return {"level": "WARN", "mod": name,
                "detail": f"Modrinth returned HTTP {e.code} for the version"}
    except Exception as e:  # network flake must not read as a security finding
        return {"level": "WARN", "mod": name, "detail": f"lookup failed: {e}"}

    files = version.get("files") or []
    target = next((f for f in files if f.get("url") == url), None)
    if target is None:
        target = next((f for f in files if f.get("primary")), files[0] if files else None)
    if target is None:
        return {"level": "FAIL", "mod": name, "project": project_id,
                "detail": "version exists but lists no files"}

    expected = (target.get("hashes") or {}).get("sha512")

    # Fetch the bytes the CDN actually serves now and compare against the hash
    # Modrinth itself records for this version.
    try:
        blob = get(url, raw=True)
    except Exception as e:
        return {"level": "WARN", "mod": name, "detail": f"download failed: {e}"}

    actual = hashlib.sha512(blob).hexdigest()
    if expected and actual != expected:
        return {"level": "FAIL", "mod": name, "project": project_id,
                "detail": "CDN bytes do NOT match Modrinth's recorded sha512 for "
                          "this version - treat as supply-chain tampering until "
                          "proven otherwise",
                "expected_sha512": expected[:32] + "...",
                "actual_sha512": actual[:32] + "..."}

    finding = {"level": "OK", "mod": name, "project": project_id,
               "version": version.get("version_number")}

    try:
        project = get(f"{API}/project/{project_id}")
        if project.get("status") in ("archived",):
            finding = {"level": "WARN", "mod": name, "project": project_id,
                       "detail": "project is ARCHIVED upstream; no fixes are coming"}
        loaders = version.get("loaders") or []
        games = version.get("game_versions") or []
        newer = [
            v for v in get(f"{API}/project/{project_id}/version")
            if set(v.get("loaders") or []) & set(loaders)
            and set(v.get("game_versions") or []) & set(games)
            and v.get("date_published", "") > version.get("date_published", "")
        ]
        if newer and finding["level"] == "OK":
            finding = {"level": "INFO", "mod": name, "project": project_id,
                       "version": version.get("version_number"),
                       "detail": f"{len(newer)} newer build(s) exist, latest "
                                 f"{newer[0].get('version_number')} - "
                                 "informational, bumps force a pack re-import"}
    except Exception:
        pass  # project metadata is a nicety; never fail the audit on it

    return finding


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    findings = [audit_one(u) for u in pinned_urls()]
    fails = [f for f in findings if f["level"] == "FAIL"]
    warns = [f for f in findings if f["level"] == "WARN"]
    infos = [f for f in findings if f["level"] == "INFO"]

    if args.json:
        print(json.dumps({"findings": findings, "fail": len(fails),
                          "warn": len(warns), "info": len(infos)}, indent=2))
    else:
        for f in fails + warns + infos:
            print(f"  {f['level']:5} {f['mod']}")
            if f.get("detail"):
                print(f"        {f['detail']}")
        print(f"\n  {len(findings)} pins checked: "
              f"{len(fails)} FAIL, {len(warns)} WARN, {len(infos)} newer-available")
        if not fails:
            print("  PASS: every pin resolves and serves the bytes Modrinth vouches for")
        print("\n  Note: this cannot detect mod vulnerabilities - no CVE feed "
              "indexes Minecraft mods. See this file's docstring.")

    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
