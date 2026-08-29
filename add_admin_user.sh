#!/usr/bin/env bash
# Add a named admin account and permit it through the SSH allowlist.
#   sudo bash add_admin_user.sh <username> ["ssh-ed25519 AAAA... optional public key"]
#
# One account per person, never a shared login: the audit trail attributes every
# command and file change to a username, and one person can be revoked without
# disturbing anyone else. That is the whole point of having turned off root SSH.
set -euo pipefail

USERNAME="${1:?usage: add_admin_user.sh <username> [\"ssh-public-key\"]}"
PUBKEY="${2:-}"
DROPIN=/etc/ssh/sshd_config.d/10-hardening.conf

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

if id "$USERNAME" >/dev/null 2>&1; then
    echo "user $USERNAME already exists; updating key/allowlist only"
else
    # uid 1100+ deliberately: uid 1000 is the container's uid, and an account
    # sharing it would tie a container escape to a sudo-capable identity.
    NEXT=$(awk -F: '$3>=1100 && $3<2000 {print $3}' /etc/passwd | sort -n | tail -1)
    NEXT=$(( ${NEXT:-1100} + 1 ))
    useradd -m -u "$NEXT" -s /bin/bash -G sudo "$USERNAME"
    echo "created $USERNAME (uid $NEXT, sudo)"
fi

if [ -n "$PUBKEY" ]; then
    install -d -m 700 -o "$USERNAME" -g "$USERNAME" "/home/$USERNAME/.ssh"
    touch "/home/$USERNAME/.ssh/authorized_keys"
    grep -qF "$PUBKEY" "/home/$USERNAME/.ssh/authorized_keys" 2>/dev/null || \
        echo "$PUBKEY" >> "/home/$USERNAME/.ssh/authorized_keys"
    chmod 600 "/home/$USERNAME/.ssh/authorized_keys"
    chown -R "$USERNAME:$USERNAME" "/home/$USERNAME/.ssh"
    echo "installed public key for $USERNAME"
    PASSWORD=""
else
    # No key supplied, so issue a strong random password and print it ONCE.
    # NOT `tr </dev/urandom | head -c 32`: head closes the pipe after 32 bytes,
    # tr dies of SIGPIPE, and under `set -o pipefail` that aborts the whole
    # script mid-setup - leaving a passwordless account outside the allowlist.
    # openssl emits a finite amount, so every stage of this pipeline exits 0.
    PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
    echo "$USERNAME:$PASSWORD" | chpasswd
    echo "password set for $USERNAME"
fi

# Append to the SSH allowlist without disturbing the accounts already on it.
# awk with an explicit exit rather than `grep | head -1`, which has the same
# SIGPIPE-under-pipefail hazard as the password pipeline above.
current=$(awk '/^AllowUsers /{ $1=""; sub(/^[[:space:]]+/,""); print; exit }' "$DROPIN")
case " $current " in
    *" $USERNAME "*) echo "already in AllowUsers" ;;
    *) sed -i "s/^AllowUsers .*/AllowUsers $current $USERNAME/" "$DROPIN"
       echo "added $USERNAME to AllowUsers" ;;
esac

if sshd -t; then
    systemctl reload ssh
else
    echo "FAIL: sshd config invalid; NOT reloading. Fix $DROPIN before disconnecting."
    exit 1
fi

echo
echo "==== effective SSH allowlist ===="
sshd -T | grep -i '^allowusers'
echo
if [ -n "$PASSWORD" ]; then
    echo "==== give this to $USERNAME over a secure channel, then delete it ===="
    echo "  host:     $(curl -s --max-time 5 ifconfig.me || echo '<this droplet'"'"'s public IP>')"
    echo "  user:     $USERNAME"
    echo "  password: $PASSWORD"
    echo
    echo "Ask them to send you an SSH public key and re-run:"
    echo "  sudo bash add_admin_user.sh $USERNAME \"ssh-ed25519 AAAA...\""
    echo "then disable their password with:  sudo passwd -l $USERNAME"
fi
