#!/usr/bin/env bash
# Who got in, from where, and what they touched. Read-only reporting over the
# audit trail. Installed on the droplet as /usr/local/bin/server-audit.
#   server-audit            last 24 hours
#   server-audit 7d         last 7 days
#   server-audit 1h changes only the change sections
set -uo pipefail

SINCE="${1:-24h}"
ONLY="${2:-all}"
# Two ausearch traps, both of which fail SILENTLY as "no changes found" - a
# dangerous way for an audit tool to lie:
#   1. With log_format=ENRICHED it reads the daemon's feed, not the log file,
#      and returns nothing. --input-logs forces it to read the actual logs.
#   2. Its -ts date parser rejects MM/DD/YYYY here, so use the keyword windows
#      (recent = 10 min, today, this-week, boot) instead of a computed date.
AU_ARGS="--input-logs"
case "$SINCE" in
    *m|1h|2h)  AU_TS="recent"    ;;
    24h|*h)    AU_TS="today"     ;;
    1d|today)  AU_TS="today"     ;;
    *)         AU_TS="this-week" ;;
esac

hdr() { echo; echo "===== $* ====="; }

if [ "$ONLY" = "all" ]; then
hdr "LOGINS (successful) - last $SINCE"
journalctl -u ssh --since "-$SINCE" --no-pager 2>/dev/null \
  | grep -E "Accepted (password|publickey)" \
  | sed -E 's/.* ([0-9]{2}:[0-9]{2}:[0-9]{2}) .*Accepted (\w+) for (\S+) from (\S+) port.*/\1  user=\3  from=\4  via=\2/' \
  || echo "(none)"

hdr "LOGIN SESSIONS (with duration)"
last -20 -F 2>/dev/null | head -20

hdr "FAILED LOGIN ATTEMPTS - last $SINCE (count by source IP)"
journalctl -u ssh --since "-$SINCE" --no-pager 2>/dev/null \
  | grep -oP "(Failed password|Invalid user).*from \K[0-9.]+" \
  | sort | uniq -c | sort -rn | head -15 || echo "(none)"

hdr "CURRENTLY BANNED (fail2ban)"
fail2ban-client status sshd 2>/dev/null | tr -d '\t' | grep -E "Currently banned|Banned IP|Total banned"
fail2ban-client status recidive 2>/dev/null | tr -d '\t' | grep -E "Currently banned|Total banned"
fi

hdr "PRIVILEGE USE (sudo) - last $SINCE"
sudo_out=$(journalctl --since "-$SINCE" --no-pager 2>/dev/null \
  | grep "COMMAND=" \
  | sed -E 's/^\S+ +[0-9]+ ([0-9:]+) .*: *(\S+) : .*COMMAND=(.*)$/\1  \2  ->  \3/' \
  | tail -30)
echo "${sudo_out:-(none)}"

hdr "FILE AND CONFIG CHANGES (window: $AU_TS)"
found_any=0
for key in identity privilege sshd_config ssh_keys home_changes mc_deploy mc_admin mc_mods docker cron systemd_units modules; do
    ev=$(ausearch $AU_ARGS -k "$key" -ts "$AU_TS" -i 2>/dev/null)
    [ -z "$ev" ] && continue
    files=$(echo "$ev" | grep -oP 'name="?\K[^"[:space:]]+' | sort -u | head -8)
    who=$(echo "$ev" | grep -oiP '\bAUID="?\K[^"[:space:],]+' | grep -v '^unset$' | sort -u | tr '\n' ' ')
    if [ -n "$files" ]; then
        found_any=1
        echo "[$key]  by: ${who:-unknown}"
        echo "$files" | sed 's/^/    /'
    fi
done
[ "$found_any" -eq 0 ] && echo "(no watched files changed in this window)"

hdr "COMMANDS RUN BY LOGGED-IN HUMANS (window: $AU_TS)"
cmd_out=$(ausearch $AU_ARGS -k human_cmd -ts "$AU_TS" -i 2>/dev/null \
  | grep -oP ' exe="?\K[^"[:space:]]+' | sort | uniq -c | sort -rn | head -20)
echo "${cmd_out:-(none recorded)}"

hdr "GAME SERVER ADMIN ACTIONS (rcon/console)"
docker logs minecraft-java --since "$SINCE" 2>&1 \
  | grep -iE "issued server command|Made .* a server operator|De-opped|banned|whitelist" \
  | tail -20 || echo "(none)"

hdr "PLAYER SESSIONS - last $SINCE"
docker logs minecraft-java --since "$SINCE" 2>&1 \
  | grep -E "joined the game|left the game|logged in with entity id" \
  | tail -20 || echo "(none)"

echo
echo "----- deeper queries -----"
echo "  ausearch -k mc_admin -i          # every ops/whitelist change, with who"
echo "  ausearch -k identity -i          # user/password/sudoers changes"
echo "  ausearch -ua <user> -i           # everything one account did"
echo "  aureport --auth --summary        # authentication summary"
echo "  aureport --file --summary        # most-touched files"
