#!/usr/bin/env bash
# SSH hardening for the droplet, applied as a drop-in so the stock sshd_config is
# left untouched (drop-ins in /etc/ssh/sshd_config.d/ override it on Ubuntu 24.04).
# Password auth stays ENABLED 
set -euo pipefail

DROPIN=/etc/ssh/sshd_config.d/10-hardening.conf

echo "== writing $DROPIN =="
cat > "$DROPIN" <<'EOF'
# Three password attempts per connection, then the connection is dropped.
# sshd counts the offered public keys against this too, so 3 is the practical
# floor while key auth is also in play.
MaxAuthTries 3

# Fewer parallel unauthenticated connections; start dropping them early.
MaxStartups 3:50:10

# A stalled login attempt holds a slot for 20 seconds, not two minutes.
LoginGraceTime 20

# Passwords remain on by admin decision (see specs/0002-hardening.spec.md).
PasswordAuthentication yes
PubkeyAuthentication yes

# No side channels into the box.
PermitEmptyPasswords no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
EOF
chmod 644 "$DROPIN"

echo "== validating config (nothing applied yet) =="
if ! sshd -t; then
    echo "FAIL: sshd config invalid, removing drop-in and leaving sshd untouched"
    rm -f "$DROPIN"
    exit 1
fi

echo "== reloading sshd (existing sessions survive) =="
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "== effective settings =="
sshd -T | grep -iE '^(maxauthtries|maxstartups|logingracetime|passwordauthentication|pubkeyauthentication|permitrootlogin|permitemptypasswords) '

echo
echo "== fail2ban (bans an IP after repeated failures; matters while passwords are on) =="
if ! systemctl is-active --quiet fail2ban; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
    cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
maxretry = 3
findtime = 10m
bantime  = 1h
EOF
    systemctl enable --now fail2ban
fi
systemctl is-active fail2ban && fail2ban-client status sshd || true

echo
echo "Done. Verify from another terminal BEFORE closing this session:"
echo "  ssh <user>@159.65.25.218"
