#!/usr/bin/env python3
"""The world spawn is set from the repo, not by hand on the server.

gitops/world_settings.conf is the one place the spawn is written down.
gitops/apply_world_settings.sh pushes it into the running server after each
healthy deploy, and the docs must agree with it. Each check below is driven
against the real script with a stand-in `docker`, because a settings file that
is read but never applied looks identical to one that works.
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONF = os.path.join(ROOT, "gitops", "world_settings.conf")
APPLY = os.path.join(ROOT, "gitops", "apply_world_settings.sh")
DEPLOY = os.path.join(ROOT, "gitops", "deploy.sh")
CONTRIB = os.path.join(ROOT, "CONTRIBUTING.md")
CI = os.path.join(ROOT, ".github", "workflows", "ci.yml")

failures = []
checks = 0


def check(name, cond, detail=""):
    global checks
    checks += 1
    if cond:
        print("PASS  %s" % name)
    else:
        failures.append(name)
        print("FAIL  %s%s" % (name, (" - " + detail) if detail else ""))


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


conf = read(CONF)
m = re.search(r'^SPAWN="(-?\d+) (-?\d+) (-?\d+)"$', conf, re.M)
check("the conf declares SPAWN as three whole numbers", m is not None)
SPAWN = " ".join(m.groups()) if m else ""


def run_apply(conf_text, docker_exit=0):
    """Run the real script against a temp repo with a recording fake docker."""
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "repo", "gitops"))
        with open(os.path.join(d, "repo", "gitops", "world_settings.conf"), "w") as fh:
            fh.write(conf_text)
        os.makedirs(os.path.join(d, "bin"))
        log = os.path.join(d, "docker.log")
        fake = os.path.join(d, "bin", "docker")
        with open(fake, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\nexit %d\n' % (log, docker_exit))
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        env = dict(os.environ, PATH=os.path.join(d, "bin") + os.pathsep + os.environ["PATH"],
                   REPO_DIR=os.path.join(d, "repo"), CONTAINER="mc-test")
        proc = subprocess.run(["bash", APPLY], env=env, capture_output=True, text=True)
        calls = read(log).splitlines() if os.path.exists(log) else []
        return proc, calls


print("== 1. the committed spawn is applied ==")
proc, calls = run_apply(conf)
check("the script exits 0", proc.returncode == 0, proc.stderr.strip()[:200])
check("it sends setworldspawn with the conf value",
      any(c.endswith('rcon-cli setworldspawn %s' % SPAWN) for c in calls), repr(calls))
check("it targets the named container", all("mc-test" in c for c in calls), repr(calls))
check("it saves afterwards so level.dat reflects the change",
      calls and calls[-1].endswith("save-all flush"), repr(calls))
check("it is idempotent (a second run sends the same commands)",
      run_apply(conf)[1] == calls)

print("== 2. a bad conf applies nothing ==")
for label, text in (
    ("missing", "# nothing here\n"),
    ("two numbers", 'SPAWN="1 2"\n'),
    ("words", 'SPAWN="a b c"\n'),
    ("injected command", 'SPAWN="1 2 3; reboot"\n'),
    ("float", 'SPAWN="1.5 2 3"\n'),
):
    proc, calls = run_apply(text)
    check("%s: exits non-zero and never calls docker" % label,
          proc.returncode != 0 and calls == [], "rc=%s calls=%r" % (proc.returncode, calls))

print("== 3. it is wired in, and the docs agree ==")
deploy = read(DEPLOY)
check("deploy.sh runs the script after the health check",
      deploy.find("apply_world_settings.sh") > deploy.find("DEPLOY OK"))
check("a failed apply cannot fail a finished deploy",
      re.search(r'apply_world_settings\.sh"\s*\|\|\s*log', deploy) is not None)
contrib = read(CONTRIB)
check("CONTRIBUTING gives the same spawn command",
      ("/setworldspawn %s" % SPAWN) in contrib)
check("CONTRIBUTING has no other /setworldspawn value",
      set(re.findall(r"/setworldspawn ([-\d ]+)", contrib)) == {SPAWN},
      repr(re.findall(r"/setworldspawn ([-\d ]+)", contrib)))
zone = json.loads(read(os.path.join(ROOT, "data", "kubejs", "config", "designers.json")))
sx, _, sz = (int(v) for v in SPAWN.split())
check("the design zone is centred on the spawn in the conf",
      (zone["zone_center_x"], zone["zone_center_z"]) == (sx, sz),
      "zone %s,%s vs spawn %s,%s" % (zone["zone_center_x"], zone["zone_center_z"], sx, sz))
check("CI runs this test", "tests/test_world_settings.py" in read(CI))
check("bash -n apply_world_settings.sh",
      subprocess.run(["bash", "-n", APPLY]).returncode == 0)

print()
if failures:
    print("%d of %d checks FAILED:" % (len(failures), checks))
    for f in failures:
        print("  - %s" % f)
    sys.exit(1)
print("all %d checks passed" % checks)
