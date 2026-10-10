# custom-mods/

Mods that are **first-party or hand-authored for this server**, with no public
Modrinth or CurseForge listing to pin a URL against. The main `MODS` list in
`docker-compose.yml` cannot hold these: it is a list of CDN URLs, each verified
against a hash the platform itself vouches for (see `tools/audit_mod_pins.py`).
There is no platform here to vouch for anything - the author and the review are
both local to this repo.

## How a jar gets in here

1. Full manual review: manifest, `mods.toml`, every class file disassembled
   with `javap` and checked for network calls, process execution, reflection
   abuse, and anything touching the filesystem or client outside the mod's
   stated purpose. A Trivy `rootfs` scan (never `fs` - it silently skips bare
   jars, see `.github/workflows/security-gate.yml`) for CVEs in any bundled
   third-party library, verified live with a planted known-vulnerable jar as a
   positive control so a clean result actually means clean.
2. Add an entry to `REVIEWED.json` with the jar's sha256, the review date, a
   summary of what was checked, and whether the client needs it too.
3. `tests/test_custom_mods_reviewed.py` then enforces that every jar here has a
   matching, hash-correct entry - a jar dropped in later without review, or
   swapped for a different file under the same name, fails CI.

## How it reaches the server

`docker-compose.yml` mounts this directory as `/mods` in the container. itzg's
image syncs `/mods` into `/data/mods` on every boot, AFTER `REMOVE_OLD_MODS`
has already wiped and `MODS` has already re-downloaded the pinned CDN jars -
so this works without weakening `REMOVE_OLD_MODS`, which still fully protects
the CDN-pinned mods from anything unreviewed landing next to them.

## If the mod needs the client too

Check `client_required` in `REVIEWED.json`. If true, the jar also needs adding
to `data/EduCraftClient.mrpack` by hand (`tools/sync_client_pack.py` only
knows about the Modrinth-sourced `MODS` list, not this directory) and the
CHANGELOG entry must say **REQUIRES PACK RE-IMPORT**.
