# Base is pinned by DIGEST, not tag. The java21 tag moves every time itzg ships
# an update, and a moving tag is a supply-chain door: a repointed or poisoned tag
# walks straight into the next build with no commit and no review. The digest
# freezes the exact image that was vetted.
#
# To update deliberately:
#   docker pull itzg/minecraft-server:java21
#   docker image inspect itzg/minecraft-server:java21 --format "{{index .RepoDigests 0}}"
# then replace the digest below, rebuild, and SCAN BOTH DIGESTS before pushing,
# so the change is justified by a diff rather than by hope:
#   trivy image --severity CRITICAL,HIGH --ignore-unfixed --scanners vuln <digest>
#
# Bumped 2026-09-12, from ...2b9f121b to ...f71707d9. Measured with trivy 0.74.0,
# same flags as .github/workflows/trivy.yml, both digests scanned:
#
#   target                      before  after
#   usr/local/bin/mc-server-runner   9      0
#   usr/bin/easy-add                 8      0
#   usr/local/bin/rcon-cli          10      1
#   usr/local/bin/mc-monitor        10      2
#   Java (mc-image-helper libs)      7      6
#   usr/local/bin/gosu              22     22
#   usr/bin/pebble                   8      8
#   usr/local/bin/restify            8      8
#   TOTAL HIGH/CRITICAL             82     47      (CRITICAL: 3 -> 2)
#
# 35 findings cleared, 0 introduced. The one that matters most is
# mc-server-runner, 9 to 0: that is PID 8 in the running container, the process
# that supervises the server, so this is not just dashboard tidying.
#
# WHAT THIS BUMP DOES NOT FIX, and an earlier note in this repo was wrong about:
# a previous bump was documented as clearing CVE-2026-40983 and CVE-2026-40984
# against io.micrometer:micrometer-core. It did not. Both are still present at
# micrometer-core 1.16.5 (fixed upstream in 1.16.6), bundled inside
# usr/share/mc-image-helper-1.68.0/lib/. That claim survived because the scanner
# used to check it was trivy 0.67.2, which did not report them; trivy 0.74.0
# does. A stale scanner is worse than no scanner, because the green check still
# reads as assurance. Keep the action pin in trivy.yml current.
#
# Digest moved 2026-09-30, f71707d9 -> 54149e92, measured not assumed: both
# images were built locally and scanned with the same trivy settings CI uses
# (CRITICAL,HIGH, ignore-unfixed). 57 findings -> 48, nothing introduced.
#   pebble       8 -> 0   rebuilt; same file size, different sha256
#                         (b47bdf55 -> 5e33a130), so confirm by HASH not size
#   mc-monitor   2 -> 1   rebuilt, 16760994 -> 16797858 bytes
#   everything else unchanged, criticals still 3
# A target with no findings is OMITTED from trivy's json entirely. That is not
# the same as "not scanned", and reading it as such is how this bump was nearly
# dismissed as a scanner artefact. Compare file hashes before believing either.
#
# Everything still outstanding lives in the BASE image and cannot be fixed here:
#   gosu    22  Go stdlib 1.24.6, the oldest toolchain in the image
#   restify  8  Go stdlib 1.26.5
#   Java    13  mc-image-helper bundled deps: micrometer-core 1.16.5,
#               scala-library 2.13.1 (CVE-2022-36944, CRITICAL), jackson 3.1.3,
#               bcprov-jdk18on 1.84 (CVE-2026-8763, CRITICAL)
#   OS       3  ubuntu 26.04 openssl / libssl3t64
#   rcon-cli 1
# None of it is anything this repo installs; this Dockerfile adds only curl and
# unzip (removed in the same layer) and one checksum-pinned sqlite native lib.
# Reachability in this deployment is low across the board: restify is itzg's
# optional REST wrapper and is not enabled, and `ps -e` in the running container
# confirms it never starts; gosu and easy-add run briefly at startup and exit;
# mc-image-helper is a CLI that resolves mods at boot and exits, serving neither
# gRPC nor HTTP, which is what both micrometer CVEs require. mc-monitor is the
# exception worth watching: the healthcheck runs it, so it executes repeatedly.
# The fix for all of it is upstream rebuilding with a current Go toolchain and
# refreshed deps. Ask itzg; do not re-pin blindly hoping a digest moves it -
# build both and diff the scans, which is what moved this pin and is what
# .github/workflows/security-gate.yml now does every week.
FROM itzg/minecraft-server:java21@sha256:63948ade43e562b9400db3bfe7367c04903d509d2c4167ace717a9a426156eb6
LABEL org.opencontainers.image.source="https://github.com/OpenSource-For-Freedom/minecraft" \
      org.opencontainers.image.description="EduCraft kid-safe Forge 1.20.1 server, hardened build"

ENV ENABLE_ROLLING_LOGS="true" \
    EXEC_DIRECTLY="true" \
    HOME="/tmp"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/sqlite-native \
    && curl -sSL -o /tmp/sqlite-jdbc.jar \
       https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.44.1.0/sqlite-jdbc-3.44.1.0.jar \
    && echo "e7f9ac47f4ae61f2e63157a1f97e0750cb6fd90c9d0bf25f188260e732f284fa  /tmp/sqlite-jdbc.jar" | sha256sum -c - \
    && unzip -p /tmp/sqlite-jdbc.jar org/sqlite/native/Linux/x86_64/libsqlitejdbc.so > /opt/sqlite-native/libsqlitejdbc.so \
    && chmod 644 /opt/sqlite-native/libsqlitejdbc.so \
    && rm /tmp/sqlite-jdbc.jar

# Trim the base image to what this server actually runs. Every binary removed
# here was a source of Trivy findings and is never executed in this deployment,
# checked against itzg's own startup scripts (docker-minecraft-server master):
#   gosu      only used by scripts/start when the container starts as ROOT, to
#             drop to the minecraft user. This image runs as uid 1000 (USER
#             below, and user: "1000:1000" in compose), so that branch never
#             runs. 22 findings, all Go stdlib.
#   restify   only used by scripts/start-deployBukkitSpigot. This is Forge.
#             8 findings.
#   easy-add  itzg's build-time downloader; no startup script calls it.
#   pebble    not referenced by any startup script.
# Kept, because they are used: rcon-cli (deploys, backups), mc-monitor (the
# healthcheck and gitops/deploy.sh's health gate), mc-server-runner (PID 8, runs
# the server), mc-image-helper (resolves mods and server.properties at boot).
# If this image is ever run as root again, put gosu back first: scripts/start
# will exec it and fail.
#
# openssl/libssl3t64 are upgraded in place: the base image ships a version with
# fixed HIGH findings available (see the table above). --only-upgrade never
# installs anything new.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade openssl libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/local/bin/gosu /usr/local/bin/restify /usr/bin/restify \
             /usr/bin/easy-add /usr/local/bin/easy-add /usr/bin/pebble /usr/local/bin/pebble

USER 1000:1000
