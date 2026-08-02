#!/usr/bin/env bash
# On-box hardening audit. Run as root on the droplet:
#   bash tests/test_droplet_hardening.sh
# Read-only: inspects config and process state, changes nothing. Exits 0 if every
# check passes, 1 otherwise. The segmentation section is the important one - it
# proves a compromise of this box cannot reach the DigitalOcean account or GitHub.

fail=0
pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1${2:+ - $2}"; fail=$((fail+1)); }
skip() { echo "SKIP  $1"; }

check() { if [ "$1" = "yes" ]; then pass "$2"; else bad "$2" "$3"; fi }

C=minecraft-java
running=$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null || echo missing)

echo "== game container =="
if [ "$running" != "true" ]; then
    bad "container $C is running" "state: $running"
else
    insp() { docker inspect -f "$1" "$C" 2>/dev/null; }
    check "$([ "$(insp '{{.Config.User}}')" != "" ] && [ "$(insp '{{.Config.User}}')" != "root" ] && echo yes || echo no)" \
          "container does not run as root" "User=$(insp '{{.Config.User}}')"
    check "$([ "$(insp '{{.HostConfig.Privileged}}')" = "false" ] && echo yes || echo no)" \
          "container is not privileged" "privileged containers own the host"
    check "$([ "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = "true" ] && echo yes || echo no)" \
          "root filesystem is read-only"
    check "$(insp '{{.HostConfig.CapDrop}}' | grep -q ALL && echo yes || echo no)" \
          "all capabilities dropped"
    check "$(insp '{{.HostConfig.SecurityOpt}}' | grep -q no-new-privileges && echo yes || echo no)" \
          "no-new-privileges set"
    check "$([ "$(insp '{{.HostConfig.PidsLimit}}')" != "0" ] && echo yes || echo no)" \
          "pids limit set" "fork-bomb guard"
    check "$([ "$(insp '{{.HostConfig.Memory}}')" != "0" ] && echo yes || echo no)" \
          "memory limit set"
    check "$(insp '{{range .Mounts}}{{.Source}} {{end}}' | grep -q docker.sock && echo no || echo yes)" \
          "docker socket not mounted into the container" "socket access equals host root"
    # Published ports: 25565 may bind anywhere; 8100 must be localhost; 25575 never.
    ports=$(docker port "$C" 2>/dev/null)
    check "$(echo "$ports" | grep -q '25565' && echo yes || echo no)" "25565 published"
    check "$(echo "$ports" | grep '8100' | grep -qv '127.0.0.1' && echo no || echo yes)" \
          "8100 published to localhost only" "$(echo "$ports" | grep 8100)"
    check "$(echo "$ports" | grep -q '25575' && echo no || echo yes)" "25575 (RCON) not published"

    echo
    echo "== game safety settings =="
    props=/root/minecraft/data/server.properties
    [ -f "$props" ] || props=$(find / -maxdepth 4 -name server.properties -path '*data*' 2>/dev/null | head -1)
    if [ -f "$props" ]; then
        check "$(grep -q '^online-mode=true' "$props" && echo yes || echo no)" \
              "online-mode=true (Microsoft account required)"
        check "$(grep -q '^white-list=true' "$props" && echo yes || echo no)" \
              "whitelist enabled"
        check "$(grep -q '^enforce-whitelist=true' "$props" && echo yes || echo no)" \
              "whitelist enforced"
        check "$(grep -q '^enable-command-block=false' "$props" && echo yes || echo no)" \
              "command blocks disabled"
        check "$(grep -q '^enable-rcon=true' "$props" && echo yes || echo no)" \
              "rcon enabled (container-internal admin path)"
    else
        skip "server.properties not found for safety assertions"
    fi
fi

echo
echo "== segmentation: this box must hold no account-reaching secrets =="
check "$([ -f /root/.config/doctl/config.yaml ] && echo no || echo yes)" \
      "no doctl config on the droplet" "a DO token here would expose the whole account"
check "$(grep -rl 'dop_v1_' /root /home /etc /srv 2>/dev/null | head -1 | grep -q . && echo no || echo yes)" \
      "no DigitalOcean token anywhere on disk" "$(grep -rl 'dop_v1_' /root /home /etc /srv 2>/dev/null | head -3 | tr '\n' ' ')"
check "$([ -f /root/.git-credentials ] && echo no || echo yes)" \
      "no stored git credentials" "would grant repo write access"
check "$(git -C /root/minecraft remote -v 2>/dev/null | grep -q '@github.com' && echo no || echo yes)" \
      "git remote carries no embedded token"
check "$(curl -s --max-time 5 http://169.254.169.254/metadata/v1/user-data 2>/dev/null | grep -qiE 'password|token|secret|key' && echo no || echo yes)" \
      "cloud-init user-data holds no secrets" "readable by anyone on this box"
check "$(ss -lntp 2>/dev/null | grep -qE ':(2375|2376) ' && echo no || echo yes)" \
      "Docker daemon not listening on TCP" "remote Docker API equals host root"

echo
echo "== ssh posture (passwords intentionally still enabled) =="
sshd_effective() { sshd -T 2>/dev/null | grep -i "^$1 " | head -1; }
if sshd -T >/dev/null 2>&1; then
    pa=$(sshd_effective permitrootlogin)
    echo "INFO  $pa"
    echo "INFO  $(sshd_effective passwordauthentication)  (on by admin decision; compensated by firewall + fail2ban)"
    check "$(sshd -T 2>/dev/null | grep -qi '^maxauthtries [1-4]$' && echo yes || echo no)" \
          "MaxAuthTries tightened to <=4" "$(sshd_effective maxauthtries)"
    check "$([ -f /root/.ssh/authorized_keys ] && [ -s /root/.ssh/authorized_keys ] && echo yes || echo no)" \
          "an authorized key exists (key path available)"
else
    skip "sshd -T unavailable"
fi
check "$(systemctl is-active fail2ban >/dev/null 2>&1 && echo yes || echo no)" \
      "fail2ban active" "brute-force protection while passwords are enabled"
check "$(systemctl is-enabled unattended-upgrades >/dev/null 2>&1 && echo yes || echo no)" \
      "unattended security upgrades enabled"

echo
echo "== host exposure =="
listening=$(ss -lnt 2>/dev/null | awk 'NR>1 {print $4}' | grep -vE '^127\.|^\[::1\]' | sed 's/.*://' | sort -un | tr '\n' ' ')
echo "INFO  listening on non-loopback: $listening"
check "$(echo " $listening " | grep -q ' 25575 ' && echo no || echo yes)" "RCON not listening publicly"

echo
echo "---"
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; else echo "$fail CHECK(S) FAILED"; exit 1; fi
