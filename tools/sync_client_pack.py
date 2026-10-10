#!/usr/bin/env python3
"""Keep data/EduCraftClient.mrpack in sync with the server's MODS list.

    python tools/sync_client_pack.py --check   # CI gate: fail if out of sync
    python tools/sync_client_pack.py --write   # regenerate the pack

Why this exists: the server mod list in docker-compose.yml and the client pack
were kept in step by hand, in the same commit, by remembering to. That held
exactly as long as someone remembered. When Ad Astra went on the server without
every family re-importing, nobody could join, and the failure showed up as
children unable to play rather than as a broken build.

The rule this enforces: every mod the server runs that a client also needs must
be in the pack, at the identical version, with hashes Modrinth itself vouches
for. Server-only mods stay out. Client-only mods stay in.

Hashes and file sizes come from the Modrinth API rather than being computed
locally, so the pack records what the CDN will actually serve. A mismatch means
the URL now points at different bytes than we reviewed, which is a supply-chain
signal worth failing on.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile

COMPOSE = "docker-compose.yml"
PACK = "data/EduCraftClient.mrpack"
CUSTOM_MODS_DIR = "custom-mods"
CUSTOM_MODS_MANIFEST = "custom-mods/REVIEWED.json"
API = "https://api.modrinth.com/v2"
HDR = {"User-Agent": "educraft-pack-sync/1.0 (+github.com/OpenSource-For-Freedom/minecraft)"}

# Mods deliberately installed on the SERVER ONLY. Clients never need these, so
# they must not enter the pack. Keep in step with tests/test_client_server_mods.py.
SERVER_ONLY = {
    "luckperms", "profanityguard", "bluemap", "prismprotect",
    "playtimestatistics", "terralith", "dungeonsarise", "spark",
}


def norm(name):
    """Jar filename -> comparable mod key. Strips version and loader token."""
    name = urllib.parse.unquote(name)
    stem = re.split(r"[-_]\d", name.lower())[0]
    stem = re.sub(r"[-_ ]?(forge|fabric|neoforge|quilt|mc)$", "", stem)
    return re.sub(r"[-_ \[\]]", "", stem)


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=45) as r:
        return json.loads(r.read().decode())


def server_mod_urls():
    src = open(COMPOSE, encoding="utf-8").read()
    m = re.search(r'MODS:\s*"([^"]+)"', src, re.S)
    if not m:
        raise SystemExit("FAIL: no MODS list in docker-compose.yml")
    return [u.strip() for u in m.group(1).split(",") if u.strip()]


def version_from_url(url):
    """Resolve a pinned Modrinth CDN url to its version record.

    The url embeds the version id: /data/<proj>/versions/<verid>/<file>.jar
    Querying by id is exact; searching by filename would not be.
    """
    m = re.search(r"/versions/([^/]+)/", url)
    if not m:
        raise SystemExit(f"FAIL: url is not version-pinned: {url}")
    return get_json(f"{API}/version/{m.group(1)}")


def build_entries():
    """Pack entries for every server mod a client also needs."""
    entries, skipped = [], []
    for url in server_mod_urls():
        jar = os.path.basename(url)
        if norm(jar) in SERVER_ONLY:
            skipped.append(jar)
            continue
        v = version_from_url(url)
        f = next((x for x in v["files"] if x.get("primary")), v["files"][0])
        if f["url"] != url:
            print(f"  WARN: compose url and Modrinth primary file differ for {jar}")
        entries.append({
            "path": f"mods/{f['filename']}",
            "hashes": {"sha1": f["hashes"]["sha1"], "sha512": f["hashes"]["sha512"]},
            "env": {"client": "required", "server": "required"},
            "downloads": [f["url"]],
            "fileSize": f["size"],
        })
    return entries, skipped


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def custom_mod_overrides():
    """Jars from custom-mods/ that the client also needs.

    These have no Modrinth URL to resolve (that is the entire reason they live
    in custom-mods/ rather than docker-compose.yml's MODS - see
    custom-mods/README.md), so they cannot become a normal modrinth.index.json
    "files" entry, which requires a downloads URL. The .mrpack format's answer
    for exactly this case is overrides/: files bundled directly in the pack
    that a launcher extracts as-is, no download needed. tests/
    test_custom_mods_reviewed.py already proves these jars match what was
    reviewed; this trusts that and does not re-review anything.
    """
    if not os.path.exists(CUSTOM_MODS_MANIFEST):
        return []
    manifest = json.loads(open(CUSTOM_MODS_MANIFEST, encoding="utf-8").read())
    out = []
    for entry in manifest.get("mods", []):
        if not entry.get("client_required"):
            continue
        jar = os.path.join(CUSTOM_MODS_DIR, entry["file"])
        if not os.path.exists(jar):
            raise SystemExit(f"FAIL: {CUSTOM_MODS_MANIFEST} lists {entry['file']!r} "
                              f"as client-required but {jar} does not exist")
        out.append({
            "disk_path": jar,
            "zip_path": f"overrides/mods/{entry['file']}",
            "sha256": sha256_of(jar),
        })
    return out


def current_pack():
    with zipfile.ZipFile(PACK) as z:
        idx = json.loads(z.read("modrinth.index.json"))
        override_hashes = {}
        for n in z.namelist():
            if n.startswith("overrides/mods/") and not n.endswith("/"):
                override_hashes[n] = hashlib.sha256(z.read(n)).hexdigest()
        return idx, z.namelist(), override_hashes


def desired_index(idx, entries):
    """Server-derived entries, plus client-only mods already in the pack."""
    server_keys = {norm(os.path.basename(e["path"])) for e in entries}
    client_only = [f for f in idx["files"]
                   if norm(os.path.basename(f["path"])) not in server_keys
                   and norm(os.path.basename(f["path"])) not in SERVER_ONLY]
    new = dict(idx)
    new["files"] = sorted(entries + client_only, key=lambda f: f["path"].lower())
    return new, client_only


def bump(v):
    parts = (v or "1.0.0").split(".")
    while len(parts) < 3:
        parts.append("0")
    try:
        parts[1] = str(int(parts[1]) + 1)
        parts[2] = "0"
    except ValueError:
        return "1.1.0"
    return ".".join(parts)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="fail if the pack is out of sync")
    g.add_argument("--write", action="store_true", help="regenerate the pack")
    args = ap.parse_args()

    idx, names, have_overrides = current_pack()
    entries, skipped = build_entries()
    want, client_only = desired_index(idx, entries)
    overrides = custom_mod_overrides()

    have = {f["path"]: f for f in idx["files"]}
    need = {f["path"]: f for f in want["files"]}

    missing = sorted(set(need) - set(have))
    extra = sorted(set(have) - set(need))
    changed = sorted(p for p in set(have) & set(need)
                     if have[p]["hashes"]["sha512"] != need[p]["hashes"]["sha512"])

    want_overrides = {o["zip_path"]: o["sha256"] for o in overrides}
    override_missing = sorted(set(want_overrides) - set(have_overrides))
    override_changed = sorted(p for p in set(want_overrides) & set(have_overrides)
                              if want_overrides[p] != have_overrides[p])

    print(f"  server mods      : {len(server_mod_urls())}")
    print(f"  server-only      : {len(skipped)} (excluded from the pack)")
    print(f"  client-only kept : {len(client_only)}")
    print(f"  custom overrides : {len(overrides)} (from {CUSTOM_MODS_DIR}/, no Modrinth URL)")
    print(f"  pack should hold : {len(want['files'])}   currently holds: {len(idx['files'])}")

    if not (missing or extra or changed or override_missing or override_changed):
        print("\n  IN SYNC: every client-facing server mod is in the pack at the same version.")
        return 0

    print("\n  OUT OF SYNC")
    for p in missing:
        print(f"      MISSING from pack : {os.path.basename(p)}")
    for p in extra:
        print(f"      STALE in pack     : {os.path.basename(p)}")
    for p in changed:
        print(f"      VERSION/HASH DIFF : {os.path.basename(p)}")
    for p in override_missing:
        print(f"      MISSING override  : {os.path.basename(p)}")
    for p in override_changed:
        print(f"      STALE override    : {os.path.basename(p)}")

    if args.check:
        print("\n  Players on the published pack would be REFUSED at the FML handshake.")
        print("  Fix: python tools/sync_client_pack.py --write, then commit the pack.")
        return 1

    want["versionId"] = bump(idx.get("versionId"))
    shutil.copy(PACK, PACK + ".bak")
    tmp = PACK + ".tmp"
    with zipfile.ZipFile(PACK) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        written = set()
        for item in zin.infolist():
            if item.filename == "modrinth.index.json":
                continue
            # A stale override gets replaced below with the reviewed jar's
            # current bytes, not carried forward from the old zip.
            if item.filename in want_overrides:
                continue
            zout.writestr(item, zin.read(item.filename))
            written.add(item.filename)
        zout.writestr("modrinth.index.json", json.dumps(want, indent=2))
        for o in overrides:
            with open(o["disk_path"], "rb") as fh:
                zout.writestr(o["zip_path"], fh.read())
    os.replace(tmp, PACK)
    print(f"\n  WROTE {PACK}: {len(want['files'])} mods, {len(overrides)} custom override(s), "
          f"versionId {idx.get('versionId')} -> {want['versionId']}")
    print("  Backup at " + PACK + ".bak")
    print("  REMEMBER: families must re-import. The Modrinth App creates a NEW")
    print("  instance on import rather than updating the existing one.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
