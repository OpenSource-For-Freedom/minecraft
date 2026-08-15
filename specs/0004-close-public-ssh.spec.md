---
id: 0004
title: Close public SSH; DigitalOcean console becomes the admin path
project: minecraft
status: draft
owner: tbgorrie
created: 2026-08-02
---

# 0004 - Close public SSH; DigitalOcean console becomes the admin path

## Problem / user story

As the server owner, I want no SSH port exposed to the internet, so that the entire
brute-force surface disappears and the only ways in are ones an attacker cannot reach.

Port 22 currently absorbs continuous attack: 94 failed logins and 13 bans were recorded in
the first audit, and one source alone made 742 attempts in two hours. The port is already
restricted to six source addresses, but that list has broken admin access three times
(a VPN exit rotated `.203` to `.213`, and a residential ISP will do the same to the
collaborator in Baku). Maintaining an address allowlist is both the weakest control here
and the most operationally fragile.

## Goal (the increment)

Remove every **human** source address from the inbound port 22 rule, leaving only
DigitalOcean's console ranges. No person can SSH in from the internet; the web console
still can.

**Corrected 2026-08-02 after pre-flight.** The first draft said to remove port 22 entirely.
That was wrong and would have been a serious mistake: the DigitalOcean **web console
connects inbound over SSH** from `162.243.x` / `198.211.x`. This was proven earlier the
same day, when the console failed with
`User root from 162.243.188.66 not allowed because not listed in AllowUsers`. Deleting the
rule would have taken the console down with it and left the Recovery Console as the only
way in: a screen-scraped TTY with no paste and no file transfer, gated on a 10-character
root password.

So the rule stays, and only its source list changes:

| Source | Today | After |
|---|---|---|
| `75.57.37.137` (home) | allowed | **removed** |
| `45.134.142.203`, `.213` (VPN exits) | allowed | **removed** |
| `185.146.112.221` (collaborator) | allowed | **removed** |
| `162.243.128.0/17` (DO console) | allowed | kept |
| `198.211.96.0/19` (DO console) | allowed | kept |

Deliberately NOT stopping or disabling `sshd`: a firewall rule is reversible in seconds
through the API, whereas re-enabling a stopped daemon requires console access that may
itself be the thing that is broken.

**Residual risk to accept:** DigitalOcean's console ranges are large (a /17 and a /19), so
any DO customer's droplet inside them can still reach port 22. That is the price of keeping
the console. It is mitigated by root being key-only (`PermitRootLogin prohibit-password`),
`AllowUsers` naming only the admin account, `MaxAuthTries 3`, and fail2ban's 3-strike
24-hour ban. Narrowing to the observed /24s would be tighter but risks breaking the console
whenever DigitalOcean uses a different host, and this environment has already punished that
kind of guess three times.

## Why this is possible now

It would not have been a month ago. Deploys are pull-based (`gitops/deploy.sh`): the droplet
polls GitHub, verifies CI, and rebuilds itself. Nothing external needs to reach in. If
deploys were push-based over SSH, closing 22 would break them.

## Acceptance criteria

- [ ] The DigitalOcean **web console** opens and gives a root shell, verified immediately
      before the change.
- [ ] The **Recovery Console** opens and accepts the root password, verified before the
      change. This is the path that survives a broken droplet-agent.
- [ ] Root password confirmed working and stored (`MC_SERVER` in `.env`); it is the only
      credential the Recovery Console accepts.
- [ ] Inbound TCP 22 lists only the two DigitalOcean console ranges; every human address
      is gone. Verify with `doctl compute firewall get`.
- [ ] SSH from the admin machine now times out (proves user access is gone).
- [ ] The web console still opens **after** the change (proves the console ranges were the
      right ones to keep). This is the check that would have caught the original error.
- [ ] Minecraft still reachable on 25565 from an external network.
- [ ] A deploy completes end to end after the change (proves GitOps is unaffected).
- [ ] `server-audit` still runs from the console.
- [ ] Break-glass procedure below executed once successfully, then closed again.

## Security requirements

- Trust boundaries: the internet-facing surface reduces to 25565 (game, gated by whitelist
  and Mojang auth) and ICMP. The admin plane moves inside DigitalOcean's authenticated
  control panel, so its security becomes the security of the DO account.
- STRIDE deltas:
  - **Spoofing:** SSH brute force becomes impossible rather than merely rate-limited. The
    DO account becomes the single identity to protect, so **2FA on DigitalOcean is now
    mandatory, not advisory**. Without it this change moves risk rather than removing it.
  - **Repudiation:** attribution weakens. Today `edueq9r3eiky` and `wali` are distinct
    accounts and auditd records who did what. The console logs in as **root**, so every
    console action attributes to root and the DO panel's own activity log becomes the only
    record of which human it was. Accept knowingly.
  - **Denial of service:** removing 22 eliminates the fail2ban churn and the associated
    risk of an admin being banned by a shared-NAT neighbour.
  - **Elevation:** unchanged on the host; the container hardening is untouched.
- Data sensitivity: unchanged. No player data is involved.
- Secrets: the root password becomes load-bearing for Recovery Console access. It is
  currently 10 characters. **Rotate it to something long before relying on it as the last
  way in.**
- Dependencies: none added.
- Security gate: must pass `security-gate`.

## Design / approach

**Change:** drop one inbound rule. Inbound becomes 25565 from anywhere plus ICMP. Outbound
is unchanged (443, DNS, NTP, ICMP).

**Break-glass (reopen 22 for a task, then close it).**

Tested 2026-08-02 and rewritten after the first version failed. Two findings from the dry
run, both of which would have caused a real lockout:

1. **`add-rules` / `remove-rules` do not do what they appear to.** `add-rules` created a
   *second* port-22 rule rather than extending the existing one, leaving two overlapping
   rules; the subsequent `remove-rules` then produced a state where the intended address
   was no longer reachable. Recovery needed a full `update`. **Always rewrite the entire
   rule set with `update`**, which replaces rather than merges.
2. **Propagation takes about 45 seconds, not instantly.** The first test declared "still
   reachable" after 10s and was simply too early. Any verification must poll for at least
   90 seconds before concluding anything.

```powershell
$env:DIGITALOCEAN_ACCESS_TOKEN = [regex]::Match((Get-Content "F:\minecraft\.env" -Raw), 'dop_v1_[A-Za-z0-9]+').Value
$fw  = "f6563e1d-a9f6-477c-9e66-39156c9f382e"
$any = "address:0.0.0.0/0,address:::/0"
$me  = (Invoke-RestMethod "https://api.ipify.org?format=json").ip

# OPEN: full rule set, console ranges plus this one address.
doctl compute firewall update $fw --name minecraft-fw --droplet-ids 585063347 `
  --inbound-rules "protocol:tcp,ports:25565,$any protocol:tcp,ports:22,address:$me/32,address:162.243.128.0/17,address:198.211.96.0/19 protocol:icmp,$any" `
  --outbound-rules "protocol:tcp,ports:443,$any protocol:tcp,ports:53,$any protocol:udp,ports:53,$any protocol:udp,ports:123,$any protocol:icmp,$any"
Start-Sleep -Seconds 50   # propagation

# ... do the work ...

# CLOSE: identical command with $me dropped from the port-22 sources.
doctl compute firewall update $fw --name minecraft-fw --droplet-ids 585063347 `
  --inbound-rules "protocol:tcp,ports:25565,$any protocol:tcp,ports:22,address:162.243.128.0/17,address:198.211.96.0/19 protocol:icmp,$any" `
  --outbound-rules "protocol:tcp,ports:443,$any protocol:tcp,ports:53,$any protocol:udp,ports:53,$any protocol:udp,ports:123,$any protocol:icmp,$any"
```

Better than a standing allowlist: access is scoped to one address, exists only while
needed, and every open and close lands in the DigitalOcean activity log.

**Verified during the dry run:** the game port stayed reachable throughout every firewall
change. Players are never affected by admin-plane work.

**Routine work after the change:**

| Task | How |
|---|---|
| Deploy code | Automatic. Push to main; the droplet pulls within 5 minutes. |
| Watch a deploy | Console: `journalctl -u minecraft-deploy.service -f` |
| Add a player | Console: `docker exec minecraft-java rcon-cli whitelist add NAME` |
| Read the audit | Console: `server-audit 24h` |
| Server logs | Console: `docker logs -f minecraft-java` |
| Anything needing file transfer | Break-glass, or commit it to the repo and let the deploy carry it |

## Files to change

- No repository files. This is a cloud firewall change.
- `specs/0002-hardening.spec.md` - mark H2's endpoint reached.
- `README.md` / `DEPLOY.md` - document console-first administration and break-glass.

## Out of scope

- Stopping or disabling `sshd` (kept running deliberately; see Goal).
- Tailscale. It remains the better long-term answer because it restores real SSH with no
  public port and keeps per-person attribution. This spec is the cheaper interim step and
  does not preclude it.
- Any change to game access. 25565 stays open to every address.

## Forbidden systems

- Do not touch the container, the world data, or the whitelist as part of this.

## Test plan

Before (all must pass, or stop):
1. Open the DO web console; confirm a root prompt.
2. Open the Recovery Console; confirm the root password works.
3. `doctl compute firewall get <id>` recorded as the rollback reference.

After:
4. `ssh mcserver` times out.
5. `Test-NetConnection 159.65.25.218 -Port 25565` succeeds.
6. Console: `docker exec minecraft-java mc-monitor status --host localhost` answers.
7. Push a trivial commit; confirm `DEPLOY OK` in the journal via console.
8. Run break-glass open, `ssh mcserver`, then close, and confirm the timeout returns.

## Definition of Done

- [ ] Acceptance criteria met with evidence.
- [ ] 2FA enabled on the DigitalOcean account (hard prerequisite).
- [ ] Root password rotated to a long value and stored in `.env`.
- [ ] Wali told his SSH access is going away and shown the console path.
- [ ] `security-gate` passed.
- [ ] Change summary written, including the attribution tradeoff.

## Blocker found in pre-flight: the collaborator has no console access

`doctl account get` shows exactly one member on the DigitalOcean team
(`c-Tburns@thesummitgrp.com`). Wali is not on it, so he cannot open the web console. His
GitHub MFA is irrelevant to this: it protects his GitHub, not a DigitalOcean panel he has
no account on.

Closing user SSH therefore **removes his access entirely** rather than relocating it. Pick
one before proceeding:

| Option | Effect | Cost |
|---|---|---|
| **Invite him to the DO team** | He gets the console, same as the owner | He also gets the whole DO account: droplets, billing, the ability to destroy things. There is no "this droplet only" role. |
| **Route him through the owner** | Owner runs anything he needs | Fine if he rarely administers; a bottleneck if he does |
| **Break-glass on request** | Owner opens 22 for his address, he works, owner closes it | Works, but his residential IP rotates, so the address must be fetched fresh each time |
| **Do Tailscale first** | He keeps real SSH under his own name, no public port | More setup now, but it is the only option that keeps per-person attribution |

Recommendation: if Wali administers the server with any regularity, **do Tailscale instead
of this spec**. It achieves the same goal (no public SSH port), keeps named accounts and
their audit trail, and does not force a choice between giving a collaborator full billing
access and giving him nothing.

## Also unverified: GitHub two-factor

DigitalOcean login is via GitHub OAuth, so the GitHub account is the root of trust for the
whole admin plane after this change. The API token in use lacks the scope to read
`two_factor_authentication`, so this must be confirmed by hand at
`github.com/settings/security` before proceeding. If it is off, this change concentrates
all server access behind a single password.

## Risks

| Risk | Mitigation |
|---|---|
| Web console broken when needed | Verified before the change; Recovery Console is the second path; break-glass is the third |
| DO account compromised = total control | 2FA mandatory before this change |
| Console is awkward: no paste, no file transfer | Break-glass for real work; ship files through the repo |
| Loss of per-person attribution | Accepted and recorded; Tailscale restores it later |
| Root password is the last resort and is short | Rotate before relying on it |

## Future work

- Tailscale on the droplet: restores named-account SSH with no public port, and ends the
  IP-rotation problem for both admins.
- Then retire the break-glass procedure entirely.
