---
id: 0002
title: Server and game-container hardening, with API-only operating model
project: minecraft
status: draft            # local work done; droplet-side steps await greenlight
owner: tbgorrie
created: 2026-08-01
supersedes:
---

# 0002 - Server and game-container hardening, with API-only operating model

## Problem / user story

As the server admin, I want the live droplet (159.65.25.218, currently wide open:
no cloud firewall, password SSH exposed, BlueMap world-readable) hardened in layers,
and I want day-to-day operation to happen through APIs (GitHub for code, DO API for
infrastructure) instead of interactive SSH, so that the kids' server stays safe even
though password SSH must remain enabled for now (user constraint, accepted risk).

## Goal (the increment)

Locally: a hardened image build plus three machine-checkable test files, with the
local tests passing. Droplet-side hardening is applied at the next greenlit
maintenance window and verified by the same tests.

## Acceptance criteria

- [ ] `tests/test_docker_hardening.ps1` exits 0 on DSKTP-TIM (Dockerfile digest pin,
      checksum gate, non-root USER, compose hardening, safe port bindings).
- [ ] `docker compose build --no-cache` succeeds with the digest-pinned base and
      checksum-pinned artifact. (Done 2026-08-01: minecraft-java:secure Built.)
- [ ] `tests/test_exposure_external.ps1` exits 0 from DSKTP-TIM (25565 up; RCON,
      Docker API, web ports closed).
- [ ] `tests/test_droplet_hardening.sh` exits 0 when run as root on the droplet
      (container flags, secrets/segmentation audit, sshd limits, no Docker TCP).
- [ ] Cloud firewall attached (spec 0001 phase 2 shape: 22+8100 pinned to admin IP,
      25565 public, nothing else).
- [ ] Security gate passed before any push/deploy of these changes.

## Security requirements

- Trust boundaries / entry points: unchanged from spec 0001 (25565 public, 22
  admin-pinned, DO API, GitHub repo as supply chain). This spec narrows them.
- STRIDE deltas:
  - Tampering/supply chain: base image digest-pinned (tag repointing dies at build);
    Maven artifact sha256-pinned (verified against locally computed hash AND Maven's
    published sha1, both match); mod jars already URL-pinned; REMOVE_OLD_MODS keeps
    the mod set exact on every boot.
  - Elevation: image bakes USER 1000:1000 so even a compose file without user: never
    runs root; cap_drop ALL, no-new-privileges, read-only rootfs already in compose.
  - Info disclosure: BlueMap rebind to 127.0.0.1 (held) + firewall closes 8100 to
    strangers; droplet secrets audit ensures no dop_v1 token, git credentials, or
    cloud-init secrets live on the box (segmentation guarantee).
  - Spoofing: ONLINE_MODE + enforced whitelist unchanged and now test-asserted.
  - DoS: pids/mem/cpu caps unchanged; firewall drops all non-game traffic.
- Data sensitivity: children's gamertags only; no new data collected; tests read
  configs, never chat logs.
- Secrets handling: DO token stays ONLY in F:\minecraft\.env on DSKTP-TIM
  (gitignored); nothing secret enters tests or the repo; rcon.password rotation on
  the droplet remains a deploy-window task (spec 0001).
- Dependencies added: none at runtime. Build-time curl/unzip already present.
- Security gate: must pass `security-gate` before done.

## Design / approach

Hardening layers (H1-H6) plus the operating model (H7):

- H1 Network: DO Cloud Firewall per spec 0001 (user applies; classifier blocks me
  from creating it). End state inbound: 25565 public; 22 and 8100 admin-IP only.
- H2 Access: admin key planted; sshd limits (AllowUsers <admin user>, MaxAuthTries 3,
  LoginGraceTime 20); fail2ban; passwords stay ON (user constraint) - compensated by
  H1 pinning + fail2ban; `ssh-import-id gh:` for GitHub-sourced keys; Phase 6
  (Cloudflare WARP + Access, GitHub SSO) remains the destination.
- H3 Host: unattended-upgrades verified active; no services beyond sshd + docker.
- H4 Game container (DONE locally, held): Dockerfile digest pin, checksum-pinned
  native lib, OCI labels, USER 1000:1000. Compose left alone except the held 8100
  rebind - it already carries user/cap_drop/no-new-privileges/read_only/tmpfs/
  pids/mem/cpu/ulimits/log caps.
- H5 Secrets/segmentation: droplet must hold zero account-reaching credentials
  (no DO token, no git credentials, no cloud-init secrets, no Docker TCP socket).
  Asserted by the droplet test. Compromise of the box then cannot reach the DO
  account, GitHub, or anything else (spec 0001 segmentation answer, now testable).
- H6 Ops: nightly backup cron with off-droplet copy; DO monitoring alerts (CPU,
  droplet down). PrismProtect provides in-game rollback.
- H7 API-only operating model (target state):
  - Code changes: PULL-based GitOps, built in gitops/ (deploy.sh + systemd
    service/timer + install_gitops.sh). The droplet polls GitHub every 5 min;
    on a new main it backs up, warns players over rcon, pulls --ff-only, chowns
    data, rebuilds, then health-gates with mc-monitor and AUTO-ROLLS-BACK to the
    previous commit if the new revision does not answer within 5 minutes.
    Deliberately NOT push-based: a GitHub Actions SSH deploy would require
    opening port 22 to GitHub's large, rotating runner IP ranges AND storing a
    droplet credential in GitHub. Pull-based needs NO inbound port and NO
    credential on the droplet (public repo, anonymous https clone) - which is
    what keeps the segmentation guarantee (H5) intact.
    CONSEQUENCE: main becomes production - protect it (2FA, branch protection,
    no shared write access; consider requiring signed commits and adding
    `git verify-commit` to deploy.sh).
    PREREQUISITE (one-time): untrack runtime-mutated files or every pull fails -
    `git rm --cached data/server.properties data/whitelist.json data/ops.json
    data/banned-players.json data/banned-ips.json` + gitignore them. Verified
    against the image's start-setupRbac: OVERRIDE_WHITELIST/OVERRIDE_OPS=true
    make EXISTING_*_FILE=SYNCHRONIZE, so the compose env vars become the
    authoritative roster and rewrite the json files on boot.
  - Optional later: GitHub Actions for CI only (run tests/ on PRs, lint compose,
    build+push an image to GHCR) with zero deploy credentials; the droplet still
    pulls. Instant deploys, if wanted, come from a webhook receiver published
    through the Cloudflare Tunnel (spec 0001 phase 6), never an open port.
  - Infra changes: DO API only (firewall rule toggles, snapshot, resize, reboot,
    rebuild). Snapshot-before-change becomes one doctl call.
  - Game admin: whitelist.json / ops.json are git-tracked - roster changes ship as
    commits through the same GitOps path. Instant actions (kick, live whitelist add)
    still need RCON, which stays box-local: DO web console, or a break-glass window.
  - Break-glass SSH: port 22's firewall rule is REMOVED by default (sshd still runs,
    internet cannot reach it). When hands-on access is needed:
    doctl adds a 22-from-my-current-IP rule, do the work, doctl removes it.
    SSH access becomes an audited, deliberate, time-boxed API action.
  - Honest limit: DigitalOcean has no run-command API (no AWS-SSM equivalent), so
    arbitrary one-off commands genuinely require the break-glass window or the web
    console. Everything routine is covered by GitOps + DO API + git-tracked rosters.

## Evidence log

- 2026-08-01 local: `tests/test_docker_hardening.ps1` 21/21 PASS, exit 0.
  `docker compose build --no-cache` OK with digest-pinned base + sha256 gate
  (jar hash cross-checked against Maven's published sha1: match).
- 2026-08-01 external probe: 25565 open (correct); 22 and 8100 open to the world
  (2 findings, both awaiting the cloud firewall); 25575/2375/2376/80/443 closed.
- 2026-08-01 on-box audit (`tests/test_droplet_hardening.sh` over SSH, read-only):
  container hardening 9/10 PASS (only 8100 published 0.0.0.0 - the held compose
  fix addresses it); game safety 5/5 PASS (online-mode, whitelist enabled AND
  enforced, command blocks off, rcon internal); **segmentation 6/6 PASS** - no
  doctl config, no dop_v1 token on disk, no git credentials, no token in the git
  remote, no secrets in cloud-init user-data, Docker not on TCP. The
  "compromise of the droplet cannot reach the DO account or GitHub" claim is now
  empirically verified, not assumed. fail2ban already active and working
  (13 total bans, 4 IPs banned at audit time, 94 failed attempts - the internet
  IS actively brute-forcing port 22). unattended-upgrades enabled.
- 2026-08-01 APPLIED (only droplet change so far, user-requested): harden_sshd.sh
  installed /etc/ssh/sshd_config.d/10-hardening.conf. Effective: maxauthtries 3
  (was 6), logingracetime 20, maxstartups 3:50:10, permitemptypasswords no,
  no X11/agent forwarding. PasswordAuthentication stays yes by decision.
  Config validated with `sshd -t` before reload; fresh login verified working
  after (FRESH LOGIN OK, maxauthtries 3).
- Droplet facts: Ubuntu 24.04.4 LTS, OpenSSH 9.6p1, repo at /root/minecraft on
  eefadef with an anonymous https remote, container up 11 days (healthy),
  host key SHA256:qzg//ZwynjyMW1/lz1CXl9NYMUhRGRqmNBjg+ufEbL0.
  NOTE: data/bluemap/** is tracked but rewritten constantly by the running
  server, so the droplet's worktree is permanently dirty - add it to the
  untrack list below or GitOps pulls will always abort.

## Files to change

- `Dockerfile` - hardened (done, held).
- `tests/test_docker_hardening.ps1` - local image/compose assertions (new).
- `tests/test_droplet_hardening.sh` - on-box audit: container flags, secrets,
  sshd, exposure (new).
- `tests/test_exposure_external.ps1` - outside-vantage port expectations (new).
- Later (greenlit window): bootstrap_droplet.sh gains fail2ban + sshd limits +
  GitOps timer install; DEPLOY.md documents the API-only model.

## Out of scope

- Disabling password SSH (user constraint; revisit with Phase 6).
- The Cloudflare WARP/Access build-out itself (spec 0001 phase 6).
- Any push, deploy, or droplet change while the hold stands.
- Off-droplet backup destination selection (Spaces vs rsync; decide in H6 work).

## Forbidden systems (must not touch)

- The running production server's data/world during hardening work.
- Other DO account resources; the friend's fullhearts site/DNS.

## Test plan

- Local (now): `powershell -File tests/test_docker_hardening.ps1` exits 0;
  `powershell -File tests/test_exposure_external.ps1` exits 0.
- Droplet (maintenance window): `bash tests/test_droplet_hardening.sh` as root
  exits 0; re-run external test afterward from a NON-admin vantage (phone hotspot)
  to confirm 8100/22 invisible to strangers.
- Regression: after any redeploy, all three run again; GitOps timer makes this a
  natural post-deploy hook.

## Definition of Done

- [ ] Acceptance criteria met with command evidence in this spec or the PR.
- [ ] security-gate passed; /security-review run before push.
- [ ] No emojis; forbidden systems untouched; comment style matches repo.
- [ ] Change summary written (what changed, what was left alone, residual risk:
      password SSH stays on per user decision, compensated by H1/H2).

## Future work / backlog

- Phase 6 GitHub SSO admin door replaces break-glass SSH as the human path.
- Off-droplet backup automation and restore drill.
- Branch protection on GitHub main once GitOps auto-deploy is live.
- Droplet region/size revisit (spec 0001 open decisions).
