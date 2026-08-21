FROM itzg/minecraft-server:java21@sha256:2b9f121bb539dde1902a1117c2ef5dbb1dfd1283fe242fc1a7a64ba8532b719f
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

USER 1000:1000
