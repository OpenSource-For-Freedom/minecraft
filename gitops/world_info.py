#!/usr/bin/env python3
"""Print the live world's spawn point and hub location on one line.

    spawn=X,Y,Z; hub=X,Y,Z

Minecraft 1.20.1 has no command that shows the world spawn, so it is read
straight out of level.dat. The hub comes from the hub.json that hub.js writes
when an op runs /hub set. Either part is left out if it can't be read.

deploy.sh adds this line to the deployment status it reports to GitHub, which
is how the coordinates get from the droplet into the repo. Standard library
only, and it never raises: a world that can't be read must not fail a deploy.
"""
import gzip
import json
import os
import struct
import sys

DATA = os.environ.get("MC_DATA", "/root/minecraft/data")


def world_spawn():
    with gzip.open(os.path.join(DATA, "world", "level.dat")) as f:
        raw = f.read()
    out = []
    for name in (b"SpawnX", b"SpawnY", b"SpawnZ"):
        # NBT int tag: type 0x03, name length (2 bytes), name, then a big-endian int32.
        tag = b"\x03" + struct.pack(">H", len(name)) + name
        i = raw.find(tag)
        if i < 0:
            return None
        start = i + len(tag)
        out.append(struct.unpack(">i", raw[start:start + 4])[0])
    return out


def hub():
    with open(os.path.join(DATA, "kubejs", "config", "hub.json")) as f:
        cfg = json.load(f)
    if not cfg.get("spawn_dim"):
        return None    # /hub set has never been run
    return [int(round(float(cfg[k]))) for k in ("spawn_x", "spawn_y", "spawn_z")]


def main():
    parts = []
    for label, read in (("spawn", world_spawn), ("hub", hub)):
        try:
            xyz = read()
        except Exception:
            xyz = None
        if xyz:
            parts.append("%s=%s" % (label, ",".join(str(v) for v in xyz)))
    print("; ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
