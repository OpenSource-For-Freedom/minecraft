#!/usr/bin/env python3
"""The droplet security alerting must not lie in either direction.

An alert channel has two ways to fail and this script has managed both. It was
too noisy first, and the fix for that quietly introduced the opposite failure:
controls that read as present and did nothing. Every check below exists because
the real file was broken in exactly that way.

WHAT IS GUARDED, AND WHY EACH ONE BIT

1. NO IDENTITY IN A PUBLIC REPO. `KNOWN_USERS` carried the live 12-character
   SSH account name as a hardcoded default. That name is the sole entry in
   sshd's AllowUsers on a box taking brute-force all day, and being
   non-obvious was the entire point of choosing it. This repo is public.

2. NO INVISIBLE NO-OPS. collect_sensitive_files listed six paths in a for-loop
   whose body was `:`, then checked three of them further down. A change to
   /etc/shadow was never reported while the code said it was watched. The
   generalisation: a control you cannot observe is a control you do not have.

3. JSON MUST SURVIVE HOSTILE INPUT. The escaper replaced quotes before
   backslashes, so `\\"` became `\\\\"` and the payload was invalid. Discord
   rejects it, curl --fail returns non-zero, and the ENTIRE batch was lost.
   One awkward character in a journal line silenced every alert in that window.

4. NON-MATCHING LINES MUST BE DROPPED. Three collectors ran sed without -n, so
   a line the grep caught but the sed could not parse was emitted verbatim into
   a stream whose contract is `severity|title|detail`. That is how a raw
   journal line with quotes in it reached the JSON builder.

5. A FAILED POST MUST NOT LOSE EVENTS. The checkpoint advanced before the post,
   so any of the above turned into permanent silent data loss.

6. SILENCE MUST NOT LOOK LIKE HEALTH. With no heartbeat, a dead timer and a
   quiet week are the same observation. This repo already documented the
   playtime limiter as dead for a month while it ran; same blind spot.

7. THE SYSTEMD SANDBOX MUST NOT HIDE WHAT IS WATCHED. The unit ran with
   ProtectHome=true, which makes /home invisible. Watching
   /home/*/.ssh/authorized_keys under it would find nothing, forever, silently.
   Those keys matter more than root's here: root cannot log in over SSH.

WHAT THIS TEST IS NOT. It does not prove alerts arrive on the droplet. It
proves the logic is correct, the controls are real, and the payload is valid
JSON for input designed to break it. Liveness is the heartbeat's job, on the
box.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERT = os.path.join(ROOT, "alerts", "security_alert.sh")
INSTALL = os.path.join(ROOT, "alerts", "install_alerts.sh")
CI = os.path.join(ROOT, ".github", "workflows", "ci.yml")

BASH = shutil.which("bash") or shutil.which("bash.exe")

failures = []
checks = 0


def ok(name):
    global checks
    checks += 1
    print("PASS  %s" % name)


def bad(name, detail=""):
    global checks
    checks += 1
    failures.append(name)
    print("FAIL  %s%s" % (name, (" - " + detail) if detail else ""))


def check(name, condition, detail=""):
    if condition:
        ok(name)
    else:
        bad(name, detail)


PRELUDE = 'MC_ALERT_LIB_ONLY=1 . alerts/security_alert.sh\n'


def bash_eval(snippet, args=()):
    """Source the alert script as a library and run `snippet` against it.

    MC_ALERT_LIB_ONLY=1 defines the functions without executing main, so the
    escaping and classification can be driven directly instead of inferred
    from a regex over the source.
    """
    proc = subprocess.run(
        [BASH, "-c", PRELUDE + snippet + "\n", "bash"] + list(args),
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return proc.returncode, proc.stdout, proc.stderr


def bash_with_payload(snippet, payload):
    """Run `snippet` with a hostile string in $PAYLOAD, delivered via a file.

    Deliberately NOT via argv. On Windows the C runtime re-parses the command
    line with its own backslash-quote rules, so `path\\"end` arrives mangled
    and the test would be measuring the platform instead of the escaper. A
    UTF-8 file read with `cat` is byte-exact on both hosts.
    """
    fd, path = tempfile.mkstemp(suffix=".payload")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(payload)
        return subprocess.run(
            [BASH, "-c", PRELUDE + 'PAYLOAD="$(cat "$1")"\n' + snippet + "\n",
             "bash", path.replace("\\", "/")],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        )
    finally:
        os.unlink(path)


with open(ALERT, "r", encoding="utf-8") as fh:
    alert_src = fh.read()
with open(INSTALL, "r", encoding="utf-8") as fh:
    install_src = fh.read()

print("== 1. no identity published in a public repo ==")

# The default must be empty. A non-empty default is the exact bug.
m = re.search(r'^KNOWN_USERS=(.*)$', alert_src, re.M)
check("KNOWN_USERS has no hardcoded default",
      m is not None and m.group(1).strip() in ('""', "''"),
      "found: %s" % (m.group(1).strip() if m else "<no assignment>"))

check("no inline default for KNOWN_SSH_USERS",
      not re.search(r'KNOWN_SSH_USERS:-[^}\s]', alert_src),
      "a :- default here would republish the account name")

check("the account list is read from the env file",
      "KNOWN_SSH_USERS:-" in alert_src or 'KNOWN_USERS="${KNOWN_SSH_USERS' in alert_src)

# Local-only: if .env is present, prove the real value is nowhere in the tree.
dotenv = os.path.join(ROOT, ".env")
secret_user = None
if os.path.isfile(dotenv):
    with open(dotenv, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("MC_SSH_USER="):
                secret_user = line.split("=", 1)[1].strip()
                break
if secret_user:
    hits = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
        for f in files:
            if f == ".env":
                continue
            p = os.path.join(base, f)
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                    if secret_user in fh.read():
                        hits.append(os.path.relpath(p, ROOT))
            except OSError:
                continue
    check("live MC_SSH_USER appears in no tracked file", not hits, "found in: %s" % hits)
else:
    print("SKIP  live MC_SSH_USER cross-check (no .env here; expected in CI)")

print("== 2. no invisible no-ops ==")

check("no for-loop with an empty body",
      not re.search(r'do\s*\n\s*:\s*\n\s*done', alert_src),
      "a `do : done` loop documents a control that does not run")

rc, declared, err = bash_eval('declare -f sensitive_paths')
for required in ("/etc/shadow", "/etc/passwd", "/etc/sudoers",
                 "/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d",
                 "/root/.ssh/authorized_keys", "/home/"):
    check("watched: %s" % required, required in declared,
          "declared nowhere in sensitive_paths")

check("sshd drop-in directory is watched, not just sshd_config",
      "sshd_config.d" in alert_src,
      "the hardening lives in sshd_config.d/10-hardening.conf")

# An unmatched glob arrives as its own literal pattern, so a missing
# /etc/sudoers.d would otherwise be reported as a changed file called
# "/etc/sudoers.d/*". Ask bash, not Python: on Windows the host cannot see the
# POSIX paths the droplet has, and this must assert the script's behaviour.
rc, out, err = bash_eval(
    'sensitive_paths | while IFS= read -r p; do '
    '[ -e "$p" ] || echo "MISSING:$p"; case "$p" in *[*]*) echo "GLOB:$p";; esac; done')
check("sensitive_paths emits only existing paths",
      "MISSING:" not in out, out.strip()[:200])
check("sensitive_paths emits no literal glob",
      "GLOB:" not in out, out.strip()[:200])

print("== 3. JSON survives hostile input ==")

# Each case is a character that has broken a hand-rolled escaper before.
hostile = [
    ('backslash', 'C:\\Users\\x'),
    ('double quote', 'he said "hi"'),
    ('backslash then quote', 'path\\"end'),
    ('quote then backslash', 'a"b\\'),
    ('lone trailing backslash', 'trailing\\'),
    ('json fragment', '"},{"name":"injected'),
    ('tab', 'a\tb'),
    ('newline in detail', 'line1'),
    ('unicode', 'caf\u00e9 \u2014 stra\u00dfe'),
]
for label, payload in hostile:
    proc = bash_with_payload('build_payload "high|Title|$PAYLOAD" "host-name" "30 minutes ago"',
                             payload)
    try:
        doc = json.loads(proc.stdout)
        value = doc["embeds"][0]["fields"][0]["value"]
        # Tabs become spaces and other control characters are dropped, because
        # neither is legal raw inside a JSON string. Everything else must
        # arrive byte for byte: an escaper that mangles content is only
        # marginally better than one that emits invalid JSON.
        expected = payload.replace("\t", " ")
        check("valid JSON and value preserved: %s" % label,
              value == expected,
              "got %r expected %r" % (value, expected))
    except (ValueError, KeyError, IndexError) as exc:
        bad("valid JSON for %s" % label,
            "%s; stdout=%r stderr=%r" % (exc, proc.stdout[:200], proc.stderr[:200]))

# A field value must fit Discord's 1024-character cap AFTER escaping, which is
# why truncation happens before escaping and leaves room for the worst case
# where every single character doubles.
proc = bash_with_payload('build_payload "high|Title|$PAYLOAD" "h" "s"', "\\" * 2000)
try:
    doc = json.loads(proc.stdout)
    escaped_len = len(json.dumps(doc["embeds"][0]["fields"][0]["value"])) - 2
    check("escaped field value stays under Discord's 1024 cap", escaped_len <= 1024,
          "escaped length %d" % escaped_len)
except (ValueError, KeyError, IndexError) as exc:
    bad("all-backslash detail produces valid JSON",
        "%s stdout=%r" % (exc, proc.stdout[:200]))

print("== 4. malformed event lines are dropped, not forwarded ==")

# This is a real fail2ban journal line that the old sed could not parse. Under
# the old code it was emitted verbatim and corrupted the payload.
raw = 'Sep 12 09:14:02 host fail2ban.actions[900]: NOTICE [sshd] Restore Ban 1.2.3.4'
proc = bash_with_payload('printf "%s\\n" "$PAYLOAD" | build_fields', raw)
check("a line with no severity|title|detail shape emits no field",
      proc.stdout.strip() == "",
      "emitted: %r" % proc.stdout[:200])

check("event-producing seds are non-printing",
      not re.search(r'\|\s*sed\s+-E\s', alert_src),
      "sed without -n passes unparsed lines through verbatim")

for fn in ("collect_sudo_sensitive", "collect_fail2ban", "collect_new_users"):
    body = re.search(r'%s\(\)\s*\{(.*?)\n\}' % fn, alert_src, re.S)
    check("%s uses sed -n ... p" % fn,
          body is not None and re.search(r'sed\s+-nE?.*\/p', body.group(1), re.S) is not None)

print("== 5. SSH login classification ==")

cases = [
    ("root", "", "high", "root cannot log in over SSH here, so an accepted root login is an incident"),
    ("root", "root alice", "high", "root must stay high even if it is listed"),
    ("alice", "alice bob", "medium", "an expected account is routine"),
    ("mallory", "alice bob", "high", "an unexpected account is not"),
    ("alice", "", "high", "an empty list must fail safe, not fail open"),
    ("ali", "alice", "high", "substring must not count as a match"),
    ("a.ice", "alice", "high", "the username must not be treated as a regex"),
]
for user, known, expect, why in cases:
    rc, out, err = bash_eval('KNOWN_USERS="$2"\nclassify_login "$1"', (user, known))
    got = out.strip()
    check("classify_login(%r, known=%r) == %s" % (user, known, expect),
          got == expect, "%s (got %s)" % (why, got or "<nothing>"))

print("== 6. a failed post retains its events ==")

# Driven, not grepped. The earlier version of these checks looked for the
# strings "PENDING" and "MAX_PENDING_TRIES" in the source, and a mutation that
# deleted the spool entirely still passed them, because those names survived
# elsewhere in the file. A grep for a control is not a test of it.
def dispatch_case(post_succeeds, initial_tries, max_tries="8"):
    """Run dispatch() with post_to_discord stubbed and the spool in a temp dir.

    Returns (rc, spool contents or None, tries contents or None).
    """
    d = tempfile.mkdtemp()
    try:
        if initial_tries is not None:
            with open(os.path.join(d, "pending-tries"), "w", encoding="utf-8") as fh:
                fh.write(str(initial_tries) + "\n")
            with open(os.path.join(d, "pending"), "w", encoding="utf-8") as fh:
                fh.write("high|Older event|from an earlier window\n")
        posix = d.replace("\\", "/")
        rc, out, err = bash_eval(
            'PENDING="$1/pending"\n'
            'PENDING_TRIES="$1/pending-tries"\n'
            'HEARTBEAT_STATE="$1/heartbeat"\n'
            'MAX_PENDING_TRIES="$2"\n'
            # Captured first: inside the stub, $3 would be the stub's own third
            # argument, not the script's.
            'STUB_RC="$3"\n'
            'post_to_discord() { return "$STUB_RC"; }\n'
            'dispatch "high|SSH login by unexpected user|mallory from 1.2.3.4" host since\n',
            (posix, max_tries, "0" if post_succeeds else "1"))

        def read(name):
            p = os.path.join(d, name)
            if not os.path.exists(p):
                return None
            with open(p, encoding="utf-8") as fh:
                return fh.read()

        return rc, read("pending"), read("pending-tries"), err
    finally:
        shutil.rmtree(d, ignore_errors=True)

rc, spool, tries, err = dispatch_case(post_succeeds=False, initial_tries=None)
check("a failed post writes the events to the spool",
      spool is not None and "mallory" in spool,
      "spool=%r" % spool)
check("a failed post records the attempt", tries is not None and tries.strip() == "1",
      "tries=%r" % tries)
check("a failed post reports failure", rc != 0, "rc=%d" % rc)

rc, spool, tries, err = dispatch_case(post_succeeds=True, initial_tries=3)
check("a successful post clears the spool", spool is None, "spool=%r" % spool)
check("a successful post clears the attempt counter", tries is None, "tries=%r" % tries)
check("a successful post reports success", rc == 0, "rc=%d err=%r" % (rc, err[:200]))

rc, spool, tries, err = dispatch_case(post_succeeds=False, initial_tries=7, max_tries="8")
check("the last allowed attempt gives up", spool is None and tries is None,
      "spool=%r tries=%r" % (spool, tries))
check("giving up is loud in the journal",
      "dropping" in err and "mallory" in err,
      "stderr=%r" % err[:300])

# dispatch_case supplies MAX_PENDING_TRIES so it can test both sides of the
# bound, which means it would not notice the bound being deleted outright.
# Read the shipped default from the script itself.
rc, out, err = bash_eval('printf "%s\\n" "$MAX_PENDING_TRIES"')
check("the script sets a retry bound by default",
      out.strip().isdigit() and int(out.strip()) > 0,
      "got %r, stderr=%r" % (out.strip(), err[:200]))

rc, spool, tries, err = dispatch_case(post_succeeds=False, initial_tries=2, max_tries="8")
check("an attempt below the bound is retried, not dropped",
      spool is not None and tries is not None and tries.strip() == "3",
      "spool=%r tries=%r" % (spool, tries))
check("a corrupt attempt counter does not disable the bound",
      dispatch_case(post_succeeds=False, initial_tries="junk")[2].strip() == "1")

print("== 7. silence cannot be mistaken for health ==")

# The default must survive, and it must be read from the script rather than
# supplied by the test: a mutation that deleted the assignment still satisfied
# a plain `"HEARTBEAT_HOURS" in source` grep, because the name appears in the
# message text too.
rc, out, err = bash_eval('printf "%s\\n" "$HEARTBEAT_HOURS"')
check("the script sets a heartbeat interval by default",
      out.strip() == "24", "got %r, stderr=%r" % (out.strip(), err[:200]))

rc, out, err = bash_eval(
    'HEARTBEAT_STATE=/nonexistent/heartbeat\n'
    'if heartbeat_due; then echo due; else echo quiet; fi')
check("with the default interval and no state, a heartbeat is due",
      out.strip() == "due", "got %r" % out.strip())

check("a heartbeat is actually posted", "Monitor is alive" in alert_src,
      "the interval is pointless if nothing sends the message")

# A never-written state file must read as due, so the very first run reports.
# A garbage state file must not be trusted as a huge epoch and go quiet forever.
for hours, state, due in (("24", "/nonexistent/heartbeat", True),
                          ("0", "/nonexistent/heartbeat", False),
                          ("", "/nonexistent/heartbeat", False),
                          ("notanumber", "/nonexistent/heartbeat", False)):
    rc, out, err = bash_eval(
        'HEARTBEAT_HOURS="$1"\nHEARTBEAT_STATE="$2"\n'
        'if heartbeat_due; then echo due; else echo quiet; fi', (hours, state))
    want = "due" if due else "quiet"
    check("heartbeat_due with HEARTBEAT_HOURS=%r is %s" % (hours, want),
          out.strip() == want, "got %r" % out.strip())

# And a state file holding junk must still be treated as "never", not as an
# enormous timestamp that suppresses the heartbeat permanently.
fd, junk = tempfile.mkstemp(suffix=".hb")
os.close(fd)
try:
    with open(junk, "w", encoding="utf-8") as fh:
        fh.write("not-a-timestamp\n")
    rc, out, err = bash_eval(
        'HEARTBEAT_HOURS=24\nHEARTBEAT_STATE="$1"\n'
        'if heartbeat_due; then echo due; else echo quiet; fi',
        (junk.replace("\\", "/"),))
    check("a corrupt heartbeat state file reads as never sent",
          out.strip() == "due", "got %r" % out.strip())
finally:
    os.unlink(junk)

print("== 8. the systemd sandbox does not hide what is watched ==")

check("ProtectHome is not true",
      not re.search(r'^ProtectHome=true', install_src, re.M),
      "ProtectHome=true makes every /home/*/.ssh/authorized_keys check a silent no-op")
check("ProtectHome is read-only",
      re.search(r'^ProtectHome=read-only', install_src, re.M) is not None)

print("== 9. the installer sets up what the script needs ==")

check("installer records KNOWN_SSH_USERS", "KNOWN_SSH_USERS" in install_src)
check("installer derives the account list from sshd",
      "sshd -T" in install_src or "AllowUsers" in install_src,
      "nobody should have to type the account name")
check("installer never records root as expected",
      "grep -v '^root$'" in install_src,
      "root is always an incident, so listing it would mask one")
check("env file stays root-only", 'chmod 600 "$ENV_FILE"' in install_src)

print("== 10. the env file is not a privilege escalation ==")

check("ownership and mode are verified before sourcing",
      "check_env_file" in alert_src and "stat -c" in alert_src,
      "this file is sourced as root")
check("check_env_file runs before the source",
      alert_src.index("check_env_file || return 1") < alert_src.index('. "$ENV_FILE"'))

print("== 11. both alert scripts are syntax-checked in CI ==")

with open(CI, "r", encoding="utf-8") as fh:
    ci_src = fh.read()
for f in ("alerts/security_alert.sh", "alerts/install_alerts.sh"):
    check("CI parses %s" % f, f in ci_src,
          "add it to the 'Shell scripts parse' step")
check("CI runs this test", "tests/test_security_alerts.py" in ci_src)

print("== 12. the scripts parse ==")
for f in (ALERT, INSTALL):
    proc = subprocess.run([BASH, "-n", f], capture_output=True, text=True)
    check("bash -n %s" % os.path.basename(f), proc.returncode == 0,
          proc.stderr.strip()[:300])

print()
if failures:
    print("%d of %d checks FAILED:" % (len(failures), checks))
    for f in failures:
        print("  - %s" % f)
    sys.exit(1)
print("all %d checks passed" % checks)
