---
id: 0001
title: EduCraft server to DigitalOcean, with fullhearts DNS and web join page
project: minecraft
status: draft            # planning-only hold: nothing pushed, nothing deployed
owner: tbgorrie
created: 2026-08-01
supersedes:
---

# 0001 - EduCraft server to DigitalOcean, with fullhearts DNS and web join page

## Problem / user story

As the server admin (op: Melfonz1960), I want the kid-safe EduCraft Forge 1.20.1 server
running on the existing DigitalOcean droplet instead of only on DSKTP-TIM, so that
approved kids can join from anywhere under a friendly fullhearts domain name, with the
same whitelist and Microsoft-account enforcement the compose file already defines.

Today: the droplet `ubuntu-Minecraft-V1` exists (Active, LON1, plain Ubuntu 24.04,
2 vCPU / 8 GB / 100 GB) and is ALREADY RUNNING a deployment of this stack
(discovered 2026-08-01 by port probe: 22, 25565, and 8100 all open; 8100 serves
BlueMap publicly). Deployment provenance and its exact revision are unverified. The repo
(OpenSource-For-Freedom/minecraft, main @ eefadef) is deploy-ready except that upstream
publishes BlueMap 8100 world-open. Local machine had no SSH key and no DO API access.

## Goal (the increment)

The EduCraft server container running on the droplet, joinable at `<droplet_ip>:25565`
by a whitelisted Microsoft-authenticated account, with a DO Cloud Firewall allowing
only SSH (admin IP) and 25565. Everything else (DNS, web page, automation) is phased
in Future work.

## Acceptance criteria

- [x] Discovery: `doctl compute droplet list` (read-only token) returns the droplet and
      its public IPv4; inventory of firewalls, reserved IPs, domains, and apps recorded
      in this spec before any change. (Done 2026-08-01, see Discovery log.)
- [ ] Cloud firewall attached to the droplet with exactly two inbound rules:
      22/tcp from admin IP only, 25565/tcp from all; verified with
      `doctl compute firewall list --format Name,InboundRules`.
- [ ] `bootstrap_droplet.sh` completes on the droplet without error (Docker from Ubuntu
      apt, repo cloned, `chown 1000:1000 data`, compose up).
- [ ] `docker logs minecraft-java` shows `Done (...)!` and stays up 10 minutes without
      restart (`docker ps` shows no restart count).
- [ ] A whitelisted Microsoft account joins at `<droplet_ip>:25565`; a non-whitelisted
      account is refused. `online-mode=true` confirmed in effective server.properties.
- [ ] From outside the droplet: 25565/tcp connects; 8100/tcp and 25575/tcp do not
      (BlueMap reachable only through `ssh -L 8100:localhost:8100`).
- [ ] rcon.password rotated on the droplet (the committed value in the public repo is
      considered burned) and RCON works via `docker exec` only.
- [ ] Build passes: `docker compose config` validates cleanly on the droplet.

## Security requirements

- Trust boundaries / entry points touched: public internet -> 25565/tcp (Minecraft
  protocol, Mojang-authenticated); public internet -> 22/tcp (SSH, key-only, admin IP
  scoped); DSKTP-TIM -> DO REST API (doctl, token-authenticated); GitHub public repo ->
  droplet (supply chain for compose, scripts, and mod list).
- STRIDE notes:
  - Spoofing: ONLINE_MODE=TRUE forces Microsoft/Mojang session auth; whitelist enforced;
    cracked clients rejected. SSH is key-only (ed25519), password auth to be disabled.
  - Tampering: repo is the deploy source; mods pinned by exact Modrinth CDN URLs
    (version-pinned jars, not floating). REMOVE_OLD_MODS wipes strays each boot.
  - Repudiation: PrismProtect block/chest logging + container json logs (10m x 3).
  - Info disclosure: BlueMap bound to 127.0.0.1 (local change, held); RCON 25575 never
    published; rcon.password committed in the public repo is burned and must be rotated.
  - DoS: rate-limit currently 0 in server.properties (revisit); mem/cpu/pids limits in
    compose cap container blast radius; DO firewall drops all non-25565 traffic.
  - Elevation: container runs uid 1000, cap_drop ALL, no-new-privileges, read_only
    rootfs; command blocks disabled; single op account.
- Data sensitivity: players are children - gamertags and chat only, no other PII;
  ProfanityGuard filters chat; whitelist + enforced survival + no PVP are the safety
  posture. Do not add any analytics or data collection.
- Zero-trust phase additions (phase 6): GitHub account compromise would equal droplet
  admin access, so the admin GitHub account requires 2FA and the Access policy pins to
  that one identity, not the whole org; the OAuth client secret lives only in
  Cloudflare's IdP config; the tunnel credential file on the droplet is root-owned
  mode 600; break-glass is DO's Recovery Console, not a password.
- Secrets handling: DO API token never enters the repo, chat, or transcript - user runs
  `doctl auth init` themselves (token lands in %AppData%\doctl\config.yaml). SSH private
  key `id_ed25519_do_minecraft` is passphrase-less for automation (accepted risk:
  local-machine compromise = droplet access; scope: this droplet only). New rcon
  password lives only on the droplet, untracked.
- Dependencies added and their provenance/registry: doctl via winget (DigitalOcean.Doctl,
  v1.164.0); droplet packages docker.io / docker-compose-v2 / git from Ubuntu 24.04 apt
  (no curl|sh installs); mod jars from cdn.modrinth.com pinned URLs.
- Security gate: must pass `security-gate` before the increment is marked done.

## Design / approach

Architecture: the game server cannot run on App Platform (HTTP/HTTPS only - no raw TCP
25565), so the droplet hosts the game and App Platform hosts only the web join page.
GitHub remains the single deployment source for both.

- Game path: GitHub main -> droplet `git pull` -> `docker compose up -d --build`
  (DEPLOY.md flow, bootstrapped by `bootstrap_droplet.sh` on the plain Ubuntu image).
- Web path (later phase): `site/` static join page + `.do/app.yaml` app spec in the
  repo -> DO App Platform (auto-deploy on push) -> `mc.<fullhearts-domain>` CNAME.
- Name path (later phase): domain DECIDED: **fullhearts.app** (friend-managed). DNS is
  on GoDaddy (ns29/ns30.domaincontrol.com), plain unproxied DNS - fine for Minecraft
  TCP. Friend adds `play.fullhearts.app` A -> droplet IP, optional
  `_minecraft._tcp.fullhearts.app` SRV so the bare name works in the client. Neither
  record exists yet (verified 2026-08-01). `.app` is HSTS-preloaded: any web page under
  it MUST serve HTTPS (App Platform/whatever gives TLS automatically; game traffic
  unaffected).
- Full Hearts fit: fullhearts.app is itself a Minecraft modpack generator that serves
  `.mrpack` files and matching server configs. Web phase pivots from "generic landing
  page" to: the friend's site hosts/serves `data/EduCraftClient.mrpack` plus the join
  instructions; a separate App Platform page may not be needed at all.
- Zero-trust admin access (planned, replaces PUBLIC SSH): the user's Cloudflare Zero
  Trust team (c-tburns) uses the GitHub OAuth app "DATA" (Client ID Ov23liXihZxSKeLCOOLf,
  secret held only in Cloudflare, never in this repo) as its identity provider.
  Target state:
  - `cloudflared` runs on the droplet with an outbound-only tunnel (443 out, nothing in).
  - SSH and BlueMap (localhost:8100) are published only through the tunnel behind an
    Access policy pinned to the admin's GitHub identity; Cloudflare's browser terminal
    or `cloudflared access ssh` reaches the shell after GitHub SSO.
  - Cloud firewall then drops port 22 entirely; inbound becomes 25565/tcp ONLY.
  - Sequencing constraint: the FIRST bootstrap session still uses the local SSH key
    (something must install cloudflared); after tunnel verification the key path is
    retired and DO's Recovery Console remains break-glass.
  - Prerequisite decision: Access public hostnames need a zone in the c-tburns
    Cloudflare account. fullhearts.app is GoDaddy/friend-owned, so either (a) the user
    parks one of their own domains in that Cloudflare account for admin hostnames, or
    (b) domain-free WARP private-network routing to the droplet. (a) is simpler to
    operate.
  - Scope limit: this covers ADMIN access only. Game traffic (25565) cannot go through
    Cloudflare (Minecraft TCP proxying is Spectrum/Enterprise) and connects direct.
    Player auth is unaffected - that stays Minecraft/Microsoft ONLINE_MODE. The DO API
    (doctl) is also separate - GitHub OAuth cannot substitute for a DO token.
- DO API access (this phase): doctl with a scoped Personal Access Token. Planning uses
  a READ-ONLY token in a dedicated context (`doctl auth init --context minecraft-ro`),
  which can enumerate droplets, networking, firewalls, domains, and apps but cannot
  mutate. A full-scope, short-expiry token is created only when deploy is greenlit and
  revoked after. The user creates tokens in the DO panel (API -> Tokens) and runs
  `doctl auth init` themselves so the token never appears in chat.

Phases: 0 discovery (read-only, now) -> 1 droplet bring-up -> 2 firewall -> 3 DNS ->
4 join page / Full Hearts pack hosting -> 5 ops (GitHub Action auto-deploy, cron
backups, Linux playtime limiter) -> 6 zero-trust admin (cloudflared tunnel + Access
with GitHub SSO, then close 22). Phases 1-2 are this spec's increment; 3-6 are
Future work.

Open decisions (need the user, none block planning):
- Where the friend adds the two DNS records: directly in GoDaddy (simplest) or by
  delegating the zone to DO/Cloudflare for API-managed records.
- Whether Full Hearts serves the EduCraft pack + join page itself (likely) or a
  separate App Platform join page is still wanted.
- Phase 6 prerequisite: which user-owned domain moves into the c-tburns Cloudflare
  account to carry the admin/Access hostnames (or WARP private routing if none).
- Region: LON1 gives US players ~90-100 ms; world is still fresh, so rebuilding in
  NYC1/NYC3 now is cheap. Decide before first world backup exists.
- Size: 2 vCPU vs DEPLOY.md's 4 vCPU floor for Create-heavy load; resize is one click
  later, revisit after first sessions with real player counts.
- Whether the join page should later take whitelist requests (would need a form target;
  a Microsoft OAuth web login is possible but is NOT the enforcement point - game auth
  already is).

## Files to change

- `bootstrap_droplet.sh` - new (held, uncommitted): apt Docker install, clone, chown,
  compose up, firewall reminder.
- `docker-compose.yml` - BlueMap port rebound to 127.0.0.1:8100 (held, uncommitted).
- `specs/0001-digitalocean-deploy.spec.md` - this spec (new folder, project-level).
- Later phases: `site/` static page, `.do/app.yaml`, `.github/workflows/deploy.yml`,
  `DEPLOY.md` updates for Ubuntu 24.04 and doctl.

## Out of scope

- Running the game server on App Platform (technically impossible) or any migration off
  the droplet.
- Buying a domain; anything on the fullhearts site itself (friend's system).
- The Linux port of the playtime limiter (flagged in DEPLOY.md; separate follow-up).
- Pushing ANY commit or deploying while the user's hold stands.
- Untracking data/server.properties from git (do with the rcon rotation, phase 1).

## Forbidden systems (must not touch)

- The existing DO resources beyond read-only listing until greenlit: no resize, no
  rebuild, no firewall edits, no DNS edits during planning.
- Other DO projects in the account (e.g. `first-project`) and unrelated droplets.
- The friend's fullhearts site: we hand over DNS records or content, we never touch
  their hosting.

## Test plan

- Discovery: `doctl --context minecraft-ro compute droplet list --format Name,PublicIPv4,Region,Memory,VCPUs` shows ubuntu-Minecraft-V1.
- Firewall: `doctl compute firewall list --format Name,InboundRules,DropletIDs` shows only 22 (admin IP) and 25565.
- Server up: `ssh root@IP "docker logs --tail 50 minecraft-java"` contains `Done (`.
- Ports from DSKTP-TIM: `Test-NetConnection IP -Port 25565` succeeds;
  `Test-NetConnection IP -Port 8100` and `-Port 25575` fail.
- Auth: join with whitelisted account (succeeds), non-whitelisted alt (refused);
  `docker exec minecraft-java rcon-cli whitelist list` matches expectation.
- Compose: `docker compose config >/dev/null; echo $?` is 0 on the droplet.

## Definition of Done

- [ ] Acceptance criteria met.
- [ ] Build and tests green (evidence attached: doctl output, docker logs, port tests).
- [ ] `security-gate` passed; `/security-review` run before the compose/bootstrap push.
- [ ] No emojis; no forbidden systems touched; style matches surrounding code.
- [ ] Change summary written: what changed, what was left alone, residual risk.

## Discovery log

- 2026-08-01 (port probe + service check from DSKTP-TIM): droplet 159.65.25.218 is
  ALREADY RUNNING the stack. Open to the internet: 22 (SSH, password-capable),
  25565 (Minecraft 1.20.1 protocol 763, MOTD "Safe Kids Server", 0/20 players),
  8100 (BlueMap web map, unauthenticated, HTTP 200). Closed: 80, 443, 25575 (RCON
  not exposed - good). No cloud firewall exists, so all of this is unfiltered.
  Whitelist/online-mode cannot be verified remotely (status pings never expose
  them); verify on the box. Deployment provenance unknown - confirm who deployed
  before any change.

- 2026-08-01: droplet ubuntu-Minecraft-V1 confirmed in panel (Active, LON1, Ubuntu
  24.04 plain image, 2 vCPU / 8 GB / 100 GB, tags minecraft+server, project
  "Minecraft Server"). Public IP not yet captured.
- 2026-08-01: fullhearts.app NS = GoDaddy (ns29/ns30.domaincontrol.com); no
  play/SRV records yet; site is a live Minecraft modpack generator (.mrpack output,
  Modrinth-backed, AI assistant beta).
- 2026-08-01: doctl 1.164.0 installed on DSKTP-TIM via winget; no token configured
  yet. User reports a DO API key saved to a .env, location not yet identified
  (not F:\.env, not in the repo). `.env` now gitignored in the repo as a guard.
- 2026-08-01 (doctl, token from F:\minecraft\.env, gitignored; user saved it as
  `,env` - comma typo - renamed): account c-Tburns@thesummitgrp.com active, droplet
  limit 10. Droplet ubuntu-Minecraft-V1 public IPv4 **159.65.25.218** (lon1, 8 GB,
  2 vCPU, active). **NO cloud firewall exists on the account** - phase 2 is the top
  priority change once greenlit; until then any port a service opens is world-reachable.
  No domains in DO DNS, no App Platform apps. One SSH key on the account: "McServer"
  (fc:b6:80:13:3b:00:5f:cc:ae:c6:5a:f1:2b:1e:44:73) - presumably authorized on the
  droplet at creation; the locally generated id_ed25519_do_minecraft key is separate
  and NOT yet authorized. Token scope unverified (reads work; no writes attempted).
- 2026-08-01: GitHub OAuth app "DATA" (org OpenSource-For-Freedom) confirmed as the
  Cloudflare Access IdP for team c-tburns: Client ID Ov23liXihZxSKeLCOOLf, callback
  c-tburns.cloudflareaccess.com/cdn-cgi/access/callback, secret added Feb 27 and
  never used, 0 users, device flow enabled. User wants this as the droplet admin
  front door instead of public SSH (spec phase 6).

## Future work / backlog

- Phase 3: fullhearts DNS records (play A / mc CNAME / optional SRV) with the friend.
- Phase 4: static join page + `.do/app.yaml`, deployed via App Platform from GitHub;
  design per `.claude\rules\ui-ux-design.md` (no generic-AI look).
- Phase 5: GitHub Action deploy-on-push (SSH to droplet), nightly cron backup with
  off-droplet copy (DO Spaces or rsync home), Linux cron+rcon playtime limiter.
- Rotate-and-untrack `data/server.properties`; set a nonzero `rate-limit`.
- Region/size ADR if LON1 or 2 vCPU proves inadequate in real sessions.
