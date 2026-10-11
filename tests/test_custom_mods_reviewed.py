#!/usr/bin/env python3
"""Every jar in custom-mods/ must have a matching, hash-correct review entry.

custom-mods/ exists for first-party mods with no public Modrinth/CurseForge
listing - see custom-mods/README.md for why they cannot go through the normal
MODS CDN-pin-plus-hash-check tools/audit_mod_pins.py performs. Because there
is no platform to vouch for these, REVIEWED.json is the vouching: a human
looked at the actual bytecode before this jar ran on a server kids play on.

This test enforces three things, each catching a different silent failure:

  FAIL  a jar exists in custom-mods/ with no entry in REVIEWED.json.
        Nothing reviewed it; it should not be here yet.

  FAIL  a jar's sha256 does not match its REVIEWED.json entry.
        The file on disk is not the file that was reviewed - it was swapped,
        corrupted, or someone "updated" it without a re-review. Treat as
        tampering until proven otherwise, exactly like a CDN hash mismatch.

  FAIL  REVIEWED.json lists a jar that is not actually in the directory.
        A stale entry is a sign the manifest and the directory have drifted
        apart, which is how a real check rots into decoration.

This does NOT scan for vulnerabilities - that already happened, by hand, at
review time. This only proves the file has not changed since.
"""
import hashlib
import json
import sys
from pathlib import Path

DIR = Path("custom-mods")
MANIFEST = DIR / "REVIEWED.json"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not DIR.is_dir():
        print("  no custom-mods/ directory - nothing to check")
        return 0

    jars = sorted(p for p in DIR.glob("*.jar"))

    if not jars and not MANIFEST.exists():
        print("  custom-mods/ has no jars and no manifest - nothing to check")
        return 0

    if not MANIFEST.exists():
        print(f"FAIL: {len(jars)} jar(s) in {DIR}/ but no {MANIFEST} to review them")
        for j in jars:
            print(f"    {j.name}")
        return 1

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entries = {e["file"]: e for e in manifest.get("mods", [])}

    failed = False

    on_disk = {j.name for j in jars}
    for name in sorted(set(entries) - on_disk):
        failed = True
        print(f"FAIL: {MANIFEST} lists {name!r} but it is not in {DIR}/")
        print("      remove the stale entry or restore the file")

    for j in jars:
        entry = entries.get(j.name)
        if entry is None:
            failed = True
            print(f"FAIL: {j.name} is in {DIR}/ but has no entry in {MANIFEST}")
            print("      it has not been reviewed - see custom-mods/README.md")
            continue

        actual = sha256_of(j)
        expected = entry.get("sha256", "")
        if actual != expected:
            failed = True
            print(f"FAIL: {j.name} sha256 does not match its review entry")
            print(f"      reviewed : {expected}")
            print(f"      actual   : {actual}")
            print("      this file is not the one that was reviewed - "
                  "treat as tampering until proven otherwise")

    if failed:
        print(f"\nSee {DIR}/README.md for the review process.")
        return 1

    print(f"  {len(jars)} jar(s) in {DIR}/, all with matching, hash-correct review entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
