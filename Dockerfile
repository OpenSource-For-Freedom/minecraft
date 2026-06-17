FROM itzg/minecraft-server:java21
ENV ENABLE_ROLLING_LOGS="true" \
    EXEC_DIRECTLY="true" \
    HOME="/tmp"
