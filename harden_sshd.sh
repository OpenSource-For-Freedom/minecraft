#!/usr/bin/env bash
# SSH hardening for the droplet, written as a drop-in so the stock sshd_config
# stays untouched (drop-ins in /etc/ssh/sshd_config.d/ override it on 24.04).
#
# READ THIS BEFORE EDITING. Every setting below that looks oddly permissive is
# there because the strict version locked somebody out of this exact server:
#
#   * MACs must include the non-ETM sha2 variants. Restricting to
#     encrypt-then-MAC only makes DigitalOcean's web console fail its handshake,
#     which removes a break-glass path.
#   * AllowUsers must list root. The console logs in AS root using an ephemeral
#     injected key; omitting it locks the console out entirely. Safe because
#     PermitRootLogin stays prohibit-password, so root cannot be brute-forced.
#   * Match User root needs MaxAuthTries 6. sshd counts every key a client
#     offers against the limit, and the console's proxy can offer several before
#     the injected one.
#   * Password-only accounts need MaxAuthTries 6 for the same reason: keys in
#     the user's agent are offered first and can exhaust a limit of 3 before the
#     password prompt is ever rendered.
#   * MaxStartups must NOT be tightened to single digits. Under the sustained
#     brute-force this host receives, a small unauthenticated-connection cap
#     means attackers fill every slot and legitimate SYNs are dropped: a
#     self-inflicted denial of service that looks exactly like a network fault.
#
# The script PRESERVES the live AllowUsers list rather than replacing it, so
# adding an account with add_admin_user.sh is never undone by re-running this.
# Run as root:  bash harden_sshd.sh
set -euo pipefail

DROPIN=/etc/ssh/sshd_config.d/10-hardening.conf
BACKUP="/root/10-hardening.conf.$(date +%F-%H%M%S).bak"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

# Preserve the accounts already permitted. Replacing this list blind is how you
# lock out a collaborator, or the console, without noticing until you need them.
EXISTING_ALLOW=""
if [ -f "$DROPIN" ]; then
    cp -a "$DROPIN" "$BACKUP"
    echo "existing drop-in backed up to $BACKUP"
    EXISTING_ALLOW=$(awk '/^AllowUsers /{ $1=""; sub(/^[[:space:]]+/,""); print; exit }' "$DROPIN")
fi
if [ -z "$EXISTING_ALLOW" ]; then
    # First run: permit root (console) plus every account in the sudo group.
    EXISTING_ALLOW="root $(awk -F: '/^sudo:/{print $4}' /etc/group | tr ',' ' ')"
fi
echo "AllowUsers will be: $EXISTING_ALLOW"

# Accounts with no authorized_keys can only get in by password, so they need
# headroom for the keys their client offers before the prompt appears.
PW_ONLY=""
for u in $EXISTING_ALLOW; do
    [ "$u" = "root" ] && continue
    home=$(getent passwd "$u" | cut -d: -f6)
    if [ -n "$home" ] && [ ! -s "$home/.ssh/authorized_keys" ]; then
        PW_ONLY="$PW_ONLY $u"
    fi
done
[ -n "$PW_ONLY" ] && echo "password-only accounts (given MaxAuthTries 6):$PW_ONLY"

{
cat <<EOF
MaxAuthTries 3
# NOT single digits: see the header. A small cap lets attackers starve the port.
MaxStartups 30:30:200
LoginGraceTime 30
MaxSessions 4

AllowUsers $EXISTING_ALLOW

# root is key-only. The DigitalOcean console needs this; brute force cannot use it.
PermitRootLogin prohibit-password

PasswordAuthentication yes
PubkeyAuthentication yes
PermitEmptyPasswords no

ClientAliveInterval 300
ClientAliveCountMax 2

# Includes the non-ETM sha2 MACs so the DigitalOcean console can negotiate.
# Drops SHA-1 and the 64-bit umacs.
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com,hmac-sha2-512,hmac-sha2-256

X11Forwarding no
AllowAgentForwarding no
PermitTunnel no

LogLevel VERBOSE
EOF

# Match blocks must come last: every directive after a Match belongs to it.
cat <<'EOF'

Match User root
    MaxAuthTries 6
EOF

for u in $PW_ONLY; do
    printf '\nMatch User %s\n    MaxAuthTries 6\n' "$u"
done
} > "$DROPIN"
chmod 644 "$DROPIN"

echo "== validating (nothing applied yet) =="
if ! sshd -t; then
    echo "FAIL: invalid config."
    if [ -f "$BACKUP" ]; then
        cp -a "$BACKUP" "$DROPIN"
        echo "previous config restored from $BACKUP; sshd untouched"
    else
        : > "$DROPIN"
        echo "drop-in emptied; stock sshd_config is in effect"
    fi
    exit 1
fi

systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "== effective =="
sshd -T | grep -iE '^(maxauthtries|maxstartups|logingracetime|allowusers|permitrootlogin|passwordauthentication|permitemptypasswords) '

echo
echo "== fail2ban =="
if ! systemctl is-active --quiet fail2ban; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
fi
# 'normal' not 'aggressive': aggressive counts policy rejections (a disallowed
# user, a closed preauth connection) as attacks, which once banned DigitalOcean's
# own console and destroyed break-glass access.
# ignoreip MUST mirror the cloud firewall's port-22 source list. Drift between
# the two lists is what leaves an allowed address bannable.
if [ ! -f /etc/fail2ban/jail.d/sshd.local ]; then
    cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
           162.243.128.0/17
           198.211.96.0/19

[sshd]
enabled  = true
mode     = normal
maxretry = 3
findtime = 15m
bantime  = 24h

[recidive]
enabled   = true
logpath   = /var/log/fail2ban.log
banaction = nftables[type=allports]
maxretry  = 3
findtime  = 1d
bantime   = 7d
EOF
    echo "wrote a fresh jail; ADD YOUR ADMIN IPs to ignoreip before relying on it"
else
    echo "existing jail left alone (it holds the admin ignoreip list)"
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true
fail2ban-client status sshd 2>/dev/null | tr -d '\t' | grep -iE 'Currently banned|Total banned' || true

echo
echo "VERIFY FROM A SECOND TERMINAL BEFORE CLOSING THIS SESSION:"
echo "  ssh <user>@$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 159.65.25.218)"
echo "If you cannot get in, restore with:  cp -a $BACKUP $DROPIN && systemctl reload ssh"
