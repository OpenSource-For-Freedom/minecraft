---
id: 0003
title: Malware and intrusion audit of the live droplet
project: minecraft
status: done            # audit complete; two findings handed to the owner
owner: tbgorrie
created: 2026-08-01
---

# 0003 - Malware and intrusion audit, droplet 159.65.25.218

Read-only audit run over SSH on 2026-08-01/02. Nothing was changed by the audit.

## Verdict

**No malware, no rootkit, no backdoor, no unauthorized system access found.**
Two non-malware findings need an owner decision (see Findings).

## What was checked and what was found

Host compromise indicators - ALL CLEAN:
- `/etc/ld.so.preload` absent (the classic LD_PRELOAD rootkit hook).
- No cron entries beyond stock Ubuntu (e2scrub, sysstat, apt, logrotate, man-db).
- No hand-added systemd units; every unit present ships with Ubuntu, cloud-init,
  or DigitalOcean's droplet agent.
- No `rc.local`, clean `/root/.bashrc`, no profile.d additions.
- No processes running from `/tmp`, `/var/tmp`, `/dev/shm`, none deleted-on-disk.
- No miner or scanner processes (xmrig, kdevtmpfsi, kinsing, sysrv, masscan...).
- Top process is the legitimate Forge server as uid 1000.
- No executables anywhere in world-writable temp directories.
- SUID set on the host is exactly stock Ubuntu.
- Only `root` has uid 0; only `root` has a login shell; no extra accounts.
- `/etc` changed in the last 3 days only by: timezone, ld.so.cache, and our own
  `sshd_config.d/10-hardening.conf`.
- Recently updated system binaries (openssl, curl, tar, scp...) are consistent
  with unattended-upgrades security patching, not tampering.

Network - CLEAN:
- Established outbound connections at audit time: only the two admin SSH
  sessions. No C2, no beaconing. The Java process held no outbound connections.
- Listening: 22, 25565, 8100 only. RCON is container-internal.

SSH access review - EXPLAINED, NOT A COMPROMISE:
- `/root/.ssh/authorized_keys` holds exactly ONE key, and it is DigitalOcean's
  ephemeral web-console key: comment
  `{"os_user":"root","actor_email":"c-Tburns@thesummitgrp.com","expire_at":...}-dotty_ssh`.
  It is issued per console session, scoped to the account owner's email, and
  already expired (01:08:17Z).
- The `Accepted publickey` logins on Aug 2 from 162.243.188.66 and
  198.211.111.194 are DigitalOcean IP ranges - i.e. the owner using the DO web
  console, which is why each shows a different ephemeral ECDSA fingerprint.
- Older interactive logins came from 185.146.112.221, 5.191.130.193,
  5.191.114.124. These are consistent with the owner's own VPN exits (the owner
  was verified using a Datacamp/Mullvad exit during this audit). OWNER MUST
  CONFIRM they recognize these; they are the only residual unknown.
- fail2ban is active and working: 94 failed attempts, 13 bans, 4 IPs banned at
  audit time. Constant brute-force pressure, zero successful password guesses by
  anyone but the owner.

Supply chain - CLEAN, VERIFIED:
- All 26 installed mod jars were hashed (sha1) and checked against Modrinth's
  published file database. **26/26 matched a published release**; zero unknown
  or modified jars. This is the strongest available evidence against a
  fractureiser-style mod trojan.
- No known Minecraft-malware IOCs on disk (nightmare.jar, libWebGL64.jar,
  lib.jar, C2 IP 85.217.144.130).
- KubeJS server scripts (which execute arbitrary JS in-process) reviewed:
  `playtime_limit.js`, `onboarding.js`, `quest_nudges.js` are the project's own
  code; the two `example.js` files are stock KubeJS hello-world. Keyword matches
  on "exec" were `.executes(` from the Brigadier command API - false positives.
  No network calls, no Runtime/eval, no obfuscation.
- Container image SUID binaries (`/usr/lib/cargo/bin/su`, `sudo.ws`, etc.) were
  compared against a fresh local build of the same digest-pinned upstream image:
  identical. They are stock upstream content, and inert in practice because the
  container runs with no-new-privileges, cap_drop ALL, and a read-only rootfs.

## Findings requiring an owner decision

1. **Three level-4 operators exist, not one.** `data/ops.json` on the droplet
   lists `Bag0biscuitz`, `N00B456`, and `Melfonz1960` - all op level 4 (full
   admin: can op others, change gamemode, run any command). The compose file
   declares `OPS: "Melfonz1960"` and the README calls that account "the only
   admin". The extras survive restarts because the image's default
   `EXISTING_OPS_FILE=SYNC_FILE_MERGE_LIST` MERGES the env list into the file
   rather than replacing it. Not evidence of intrusion - anyone with console or
   RCON access could have added them, and they may be intended (a friend, a
   kid). But on a kids' server an unintended admin is a real safety issue.
   ACTION: confirm both names. To make compose authoritative, set
   `OVERRIDE_OPS: "true"` so the file is SYNCHRONIZEd from the env each boot.

2. **The whitelist is empty while whitelisting is enforced.** `whitelist.json`
   is `[]` with `white-list=true` and `enforce-whitelist=true`. Since operators
   bypass the whitelist, the practical effect is that ONLY those three ops can
   currently join - no other kid can get in. ACTION: populate the roster (via
   the `WHITELIST` env in compose, plus `OVERRIDE_WHITELIST: "true"` so it is
   authoritative) before expecting anyone else to play.

## Residual risk (unchanged by this audit)

- Port 22 and BlueMap 8100 remain open to the entire internet: no cloud firewall
  exists on the account. This is the largest outstanding exposure.
- Root login with a 10-character password remains enabled by owner decision;
  fail2ban and MaxAuthTries 3 are the compensating controls.
- BlueMap on 8100 is an unauthenticated live map of a children's server.

## Method note

Audit commands were transferred base64-encoded: piping a file through PowerShell
into `plink "bash -s"` prepends a UTF-8 BOM that breaks the shebang line.
