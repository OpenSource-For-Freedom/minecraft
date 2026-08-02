# Base is pinned by digest, not tag: the java21 tag moves every time itzg ships an
# update, and a moving tag is a supply-chain door (a repointed/poisoned tag walks
# straight into the next build). The digest freezes the exact image we vetted.
# To update deliberately:
#   docker pull itzg/minecraft-server:java21
#   docker image inspect itzg/minecraft-server:java21 --format "{{index .RepoDigests 0}}"
# then replace the digest below and rebuild.
FROM itzg/minecraft-server:java21@sha256:4b6a75fd5cbca70ca3580ae8c0ea67286dd99c303554bb57e95bb2bade32f428

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
