# Changelog

Notable changes to the EduCraft server, newest first.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates
are the merge date to `main`. A PR number in brackets links the full reasoning,
which is usually worth reading: several entries below record a wrong diagnosis
being corrected, and those are the ones most likely to save someone time later.

**Player impact is called out explicitly.** Anything marked
**REQUIRES PACK RE-IMPORT** means every family must download
`data/EduCraftClient.mrpack` again or they will be refused at the FML handshake.

## [Unreleased]

### Security
- **In-game computers can no longer call arbitrary hosts.** CC:Tweaked ships
  every child a programmable computer with an HTTP API, and its stock rules are
  `deny $private` then `allow *`. Any whitelisted player could write four lines
  of Lua and make the server issue outbound requests to anything on the
  internet, including the DigitalOcean metadata endpoint. That is server-side
  request forgery with a child at the keyboard, and it was reachable on the
  live server.

  The rules cannot be committed: they are Forge SERVER config, stored per-world
  at `world/serverconfig/computercraft-server.toml`, and both `data/config/` and
  `data/world/` are gitignored on purpose because tracking files the server
  rewrites leaves the droplet worktree dirty and blocks `git pull --ff-only`.
  So they are applied at every container start through itzg's
  `PATCH_DEFINITIONS`, which has the useful property of re-asserting itself on
  every boot rather than being an edit someone can undo by hand on the box.
  See `data/patches/computercraft-http.json`.

  **Player impact:** the built-in `pastebin` and `wget` programs now fail with
  "domain not permitted" for every host. Allowing one host back is a single
  entry above the catch-all deny.

  **Verified locally against the pinned image before shipping**, by running
  `mc-image-helper patch` over a seeded stock config and parsing the result.
  That caught two format traps that would each have failed silently on the
  droplet with CI green: a file in a `PATCH_DEFINITIONS` *directory* must be a
  PatchDefinition (`file` + `ops`) and not a PatchSet (`patches: [...]`), and it
  must be strict JSON, because `--json-allow-comments` applies to the files
  being patched and not to the definition itself. Both are now CI failures and
  are written up in `data/patches/README.md`.

  Note the patcher rewrites TOML in a flattened single-quoted form rather than
  `[[http.rules]]` blocks. Both are valid TOML, but it means grepping for
  `host = "*"` finds nothing, so `tools/verify_cc_http.sh` parses the TOML
  properly instead of pattern-matching it.

  **Still not verified on the droplet.** Local proof is that the patch applies
  and produces correct rules; only reading the effective config inside the
  running container proves it applied there. Run `tools/verify_cc_http.sh` after
  the first deploy carrying this change.

### Added
- **Open Parties and Claims**, required on both client and server (no
  dependencies to pull in). Integrates with Xaero's Minimap/World Map, already
  in the pack, so claims show up on the same map. Pack bumped to versionId
  1.2.1. **REQUIRES PACK RE-IMPORT.**
- Droplet-side security alerting to Discord. A systemd timer runs every 15
  minutes and reports SSH logins, failed-auth bursts, sensitive sudo, fail2ban
  bans, container faults, `ops.json` changes, sensitive file edits, new user
  accounts and a filling disk. Silent otherwise. Installed and running on the
  droplet; see `alerts/`. [#25, #26]

### Fixed
- **The daily playtime limiter was never actually off, and this repo said it
  was for a month.** #21 deleted the Windows `playtime_limit.ps1` and wrote
  "there is currently no time limit of any kind" into DEPLOY.md and this
  changelog. That conflated two different limiters: the KubeJS one,
  `data/kubejs/server_scripts/playtime_limit.js`, was added 2026-07-20 and has
  been tracked, mounted and loading on every boot the whole time.

  A parent told no parental control exists goes looking for another way to
  limit their child, or concludes the server is unsuitable. Being wrong in the
  alarming direction is still being wrong.

  The root cause was not the deletion, it was that nothing was observable. The
  limiter now announces itself on load (`[playtime] limiter ACTIVE ...`, so
  `docker logs minecraft-java | grep playtime` answers the question), and any
  player can run `/playtime` to see their usage and remaining time. Ops, who
  are exempt and whose own numbers prove nothing, see the limiter's configured
  state instead. DEPLOY.md now carries a dated correction, and
  `tests/test_playtime_limiter.py` fails if the claim is reintroduced.

- Health check and security alerts rebuilt around zero false positives. Three
  collectors fired during normal operation, one of which (`RestartCount > 0`)
  would have alerted on **every run forever** after any deploy, because that
  counter is cumulative. Restarts are now detected by comparing `StartedAt`.
  [#26]
- Manual workflow dispatch no longer posts a status card by default. [#26]

## 2026-08-15

### Added
- **Server health check** reporting to Discord, running every 30 minutes.
  Reports three states rather than up/down, because the server answers roughly
  one ping in four from some networks while being completely healthy, and a
  one-shot check would page constantly. Deliberately holds no SSH credential:
  port 22 is open only to DigitalOcean console ranges, so a runner cannot reach
  the box, and opening it or parking a key in CI would trade a real security
  boundary for a richer report. [#23, #24]

### Changed
- **POC mode.** Moderation controls removed: Profanity Guard (chat filter) and
  `FORCE_GAMEMODE`. Every restriction removed so far had caused an outage or a
  support incident. The whitelist and `ONLINE_MODE` were deliberately **kept**:
  they are the difference between a private family server and a public one, and
  the game port is scanned continuously. Backlog in `specs/0006`. [#22]

### Removed
- Six Windows-era scripts the droplet made dead: local backup, shutdown and
  scheduled-task wrappers, plus a UTF-16 command dump from a newer Minecraft
  than we run. [#21]
- **The daily playtime limiter went with them, and it had already stopped
  working.** It capped each child at 120 minutes a day and has not run since the
  move to the droplet, so that parental control was silently off for weeks.
  `DEPLOY.md` now says so plainly instead of describing it as merely needing a
  port. [#21]

## 2026-08-14

### Fixed
- **Flight enabled**, so Ad Astra works in space. Players stepping out of the
  ship on the Moon were kicked with "Flying is not enabled on this server":
  low gravity and jetpacks look identical to the vanilla airborne check. This
  gives up the last automatic fly-hack check, accepted deliberately given an
  enforced whitelist, verified accounts, PvP off, and PrismProtect logging every
  block change. [#20]

### Security
- The six `mc-image-helper` CVEs assessed and accepted, one critical. They live
  in the base image and cannot be upgraded from here: a further digest bump
  would change nothing because upstream still ships helper 1.66.0. The
  assessment is deliberately **not** uniform, because jackson does parse remote
  JSON at container start while micrometer and scala are genuinely unreachable.
  No Trivy ignore file, so the critical stays visible. `specs/0005`. [#18]

## 2026-08-12

### Added
- **Ad Astra 1.15.20** plus Resourceful Lib, Resourceful Config and Botarium.
  Rockets, and travel to the Moon, Mars, Venus, Mercury and Glacio with oxygen,
  space suits and rovers. **REQUIRES PACK RE-IMPORT.** [#17]
- **When Dungeons Arise 2.1.58.** Large hand-built structures: pirate ships,
  mountain castles, sky keeps. Server-side only, no player action needed. [#15]

### Changed
- Memory raised for the new dimensions: heap 4G to 5G, container cap 6g to 6.5g.
  Deliberately not the 6G discussed, because a JVM needs significant memory
  outside its heap and setting them equal invites the OOM killer. [#17]
- Base image bumped to clear two HIGH micrometer CVEs. **It did not work**, and
  the PR said in advance that the Trivy scan would be the verdict. It was. [#16]

### Fixed
- **Spawn protection off.** At 16 blocks it silently stopped non-ops placing
  blocks near world spawn, which had been moved to the owner's house. Minecraft
  gives no error for this, so it read as the server being broken. [#13]
- Chunky removed after it appeared to lock players out. **The stated reason was
  wrong**, and #15 corrected it: reading the jars showed terralith, luckperms,
  bluemap, prismprotect and playtimestatistics all omit `displayTest`
  identically, and all were live while people played. The red X is advisory. The
  real cause of that outage was network loss, not mods. [#14, #15]

## 2026-08-10

### Changed
- Droplet resized to 4 vCPU and the container cap raised from 2.0 to 3.5 cores.
  The cap, not the droplet size, was the real limit: the container sat pegged at
  ~197% of two cores during worldgen, so the resize alone would have bought
  nothing. [#12]

## 2026-08-06

### Added
- **Terralith 2.5.4** worldgen. Server-side only, so no pack re-import. Affects
  newly generated chunks only; explored terrain is unchanged and there is a
  visible seam where old meets new. [#11]

### Security
- Legion runner pinned to a full commit SHA rather than a tag. [#10]

## 2026-08-02

### Added
- Server icon for the multiplayer list. [#7]
- Website: privacy policy, full SEO, and a committed test suite gating both.

### Changed
- Renamed from "Safe Kids Server" to **EduCraft**. The old MOTD advertised to
  every internet-wide scanner that children play here, which is precisely the
  audience not wanted. Safety comes from the whitelist and online-mode, not the
  label.
- Every mod pinned to an immutable Modrinth version URL. `MODRINTH_PROJECTS`
  resolved five mods **by name**, meaning any restart could silently swap in
  whatever upstream had published, including a compromised build, with no
  commit and no notification.

### Removed
- **MythicalAC anticheat**, after it kicked a whitelisted player for opening a
  door. No config file, no ops exemption, no server-side logging, so nothing
  could be tuned. Do not re-add an anticheat without all three. [#9]

### Security
- Pull-based GitOps deploy: the droplet polls GitHub, verifies every CI check
  passed, backs up, rebuilds, health-checks and rolls back on failure. Nothing
  external needs to reach in, which is what later allowed public SSH to close.
  [#5]
- Public SSH closed to everything but DigitalOcean console ranges. `specs/0004`.
- Container hardened: read-only rootfs, `USER 1000:1000`, all capabilities
  dropped, `no-new-privileges`, pids capped, BlueMap rebound to localhost.
- auditd with 27 rules, persistent journald, fail2ban with sshd and recidive
  jails.
- Malware audit: all 26 mod jars verified against Modrinth published hashes,
  26/26 clean, no fractureiser IOCs, no persistence, no C2. `specs/0003`.

## 2026-04-16

### Added
- Initial server, backup policy and Forge 1.20.1 modpack.
