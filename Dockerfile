FROM itzg/minecraft-server:java21
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
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/sqlite-native \
    && curl -sSL -o /tmp/sqlite-jdbc.jar \
       https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.44.1.0/sqlite-jdbc-3.44.1.0.jar \
    && unzip -p /tmp/sqlite-jdbc.jar org/sqlite/native/Linux/x86_64/libsqlitejdbc.so > /opt/sqlite-native/libsqlitejdbc.so \
    && chmod 644 /opt/sqlite-native/libsqlitejdbc.so \
    && rm /tmp/sqlite-jdbc.jar
