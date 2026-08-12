# Base is pinned by digest, not tag: the java21 tag moves every time itzg ships an
# update, and a moving tag is a supply-chain door (a repointed/poisoned tag walks
# straight into the next build). The digest freezes the exact image we vetted.
# To update deliberately:
#   docker pull itzg/minecraft-server:java21
#   docker image inspect itzg/minecraft-server:java21 --format "{{index .RepoDigests 0}}"
# then replace the digest below and rebuild.
# Bumped 2026-08-12 (was ...4b6a75fd, built 2026-08-01) to clear two HIGH Trivy
# findings against io.micrometer:micrometer-core 1.16.5, which ships inside the
# base image's mc-image-helper and is not something this repo installs:
#   CVE-2026-40983  gRPC denial of service   CVSS 7.5
#   CVE-2026-40984  HTTP denial of service   CVSS 7.5
# Both need an attacker to reach a Micrometer-instrumented gRPC or HTTP endpoint.
# mc-image-helper is a CLI that resolves and downloads mods at container start
# and then exits; it serves neither protocol and is never network-reachable, so
# neither CVE is exploitable in this deployment. Bumped anyway because it is free
# and a noisy alert list hides the finding that does matter one day.
# This build carries mc-image-helper 1.66.0 (was 1.64.0). micrometer is a
# TRANSITIVE dependency there, pinned by no build file in that repo, so which
# version it resolves to could not be confirmed by inspection. The Trivy scan on
# this commit is the verification: if the two CVEs above still appear against
# micrometer-core after this merges, the bump did not carry the fix and the next
# step is asking itzg to update, not re-pinning blindly.
FROM itzg/minecraft-server:java21@sha256:2b9f121bb539dde1902a1117c2ef5dbb1dfd1283fe242fc1a7a64ba8532b719f

LABEL org.opencontainers.image.source="https://github.com/OpenSource-For-Freedom/minecraft" \
      org.opencontainers.image.description="EduCraft kid-safe Forge 1.20.1 server, hardened build"

ENV ENABLE_ROLLING_LOGS="true" \
    EXEC_DIRECTLY="true" \
    HOME="/tmp"

# PrismProtect 1.3.2 bundles sqlite-jdbc 3.44.1.0, whose native lib IS present
# in the mod jar (org/sqlite/native/Linux/x86_64/libsqlitejdbc.so) but its
# loader can't find it at runtime under Forge's per-mod module classloader
# (throws NativeLibraryNotFoundException, leaves DatabaseManager.conn null,
# crashes the server on the next DB write). Fetch the identical native lib
# straight from Maven Central at build time and hand it to sqlite-jdbc
# directly via -Dorg.sqlite.lib.path (see docker-compose.yml), bypassing
# that broken lookup entirely.
# The download is checksum-pinned: a tampered or swapped Maven artifact fails
# the build instead of shipping unverified native code into the image.
# Only curl and unzip, --no-install-recommends so apt does not drag in a tail of
# suggested packages nobody reviewed. These come from Ubuntu's signed repos and
# are removed from the final layer below, so they exist only during the build.
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

# Never run as root even if a compose file forgets user:. Matches the uid the
# compose service and the data/ volume ownership already use, so behavior under
# compose is unchanged; this only removes the root-by-default footgun.
USER 1000:1000
