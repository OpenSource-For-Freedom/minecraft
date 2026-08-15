---
id: 0006
title: POC mode - moderation stripped, backlog to restore before real use
project: minecraft
status: accepted
owner: tbgorrie
created: 2026-08-15
---

# 0006 - POC mode: moderation stripped, and the backlog to restore

EduCraft is a proof of concept. Controls that kick, filter or restrict players
have been removed so the thing can be played with without fighting it. This file
is the record of what came off and what must go back before it is anything more
than a family experiment.

## Removed now

| Control | Was | Now | Why it was removed |
|---|---|---|---|
| **Profanity Guard** | chat filter mod | **removed** | Filters and blocks messages. Pure moderation, no gameplay value in a POC. |
| **FORCE_GAMEMODE** | `true` | `false` | Forced every player back to survival on join, overriding an op who had switched to creative. Actively fought the people using it. |
| Playtime limiter | 120 min/day cap | **already gone** | Windows-only, dead since the droplet move. Removed in the cleanup PR; see DEPLOY.md. |
| Spawn protection | 16 blocks | **already 0** | Blocked non-ops building near the house, silently and with no error. |
| Airborne kick | `allow-flight=false` | **already true** | Kicked players for using Ad Astra in space. |
| Anticheat (MythicalAC) | installed | **gone 2026-08-02** | Kicked a whitelisted player for opening a door. No config, no exemptions. |

## Deliberately KEPT, and why

These are not moderation. They are the difference between a private family server
and an open one, and removing them changes who can reach children.

- **Whitelist (`ENABLE_WHITELIST` / `ENFORCE_WHITELIST`)**: the entire access
  control. Turning it off puts a server with children on it on the open internet,
  where it will be found within hours; the port is scanned continuously already
  (see the VANILLA connection attempts in any day's log). **Do not remove for
  convenience.** If it is ever removed, it is a deliberate decision to run a public
  server, and everything else in this file gets revisited at the same time.
- **`ONLINE_MODE=TRUE`**: requires a real Microsoft account. Turning it off allows
  anonymous clients and lets anyone impersonate any username, including an op.
- **PrismProtect**: passive block-change logging. It blocks nothing and kicks
  nobody; it is what makes griefing reversible. Removing it removes the ability to
  undo, not a restriction.
- **LuckPerms**: permissions plumbing, currently only used for op levels.
- **PvP off**: kept because it prevents kids hurting each other, not because it
  restricts anyone's building. Trivial to flip if they want to duel.

## Backlog, in the order it should return

1. **Chat filtering**, if the player group ever includes anyone not personally
   known. Profanity Guard was adequate; the pinned version is in git history.
2. **Playtime limits**, as a Linux cron job driving `rcon-cli` rather than the old
   Windows script. Wanted as a parenting tool, not a security control.
3. **Anticheat**, only with a config file, ops exemption and server-side logging.
   The last one had none of those and had to be uninstalled. See issue #8.
4. **Spawn protection**, only if world spawn moves somewhere public.
5. **Per-role permissions** via LuckPerms, so trusted players can moderate without
   full op. Attempted 2026-08-14: LuckPerms commands return nothing over RCON, so
   it must be configured from in-game or by switching its storage to YAML.

## The line

Removing friction from a POC is right. The line is anything that controls **who
can connect**: whitelist and online-mode stay until this stops being a server with
children on it, or until someone decides otherwise knowing exactly what it means.
