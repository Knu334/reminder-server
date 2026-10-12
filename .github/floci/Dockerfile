# CI用。開発コンテナと同じFloci 2.2.0とpatchを、native-imageを使わずJVMで動かす。
# native buildは数十分と6GBのheapを要し、GHAのprivate runnerに向かない。
# build: docker buildx build --build-context patch=.devcontainer/floci .github/floci
FROM ubuntu:noble AS source

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/floci
RUN git clone --depth 1 --branch 2.2.0 https://github.com/floci-io/floci.git . \
    && test "$(git rev-parse HEAD)" = "17c99047b92b5729b356f3584513cd6ed598b8a9"

COPY --from=patch floci-refresh.patch /tmp/floci-refresh.patch
RUN git apply --check /tmp/floci-refresh.patch \
    && git apply /tmp/floci-refresh.patch

# 上流docker/Dockerfileと同じJVM build。Mavenは上流付属の./mvnwを使う。
FROM eclipse-temurin:25.0.1_8-jdk AS build
WORKDIR /src/floci
# mvnwはdistributionSha256Sumの検証付きでMavenを展開するためにunzipを要する。
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=source /src/floci/ /src/floci/
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -q -DskipTests package

# 上流docker/Dockerfileのruntime stageから、E2Eで使わないAWS CLIを除いたもの。
FROM eclipse-temurin:25.0.1_8-jre

ENV FLOCI_VERSION=2.2.0-local-refresh.7-jvm \
    FLOCI_STORAGE_PERSISTENT_PATH=/app/data

RUN useradd -r -u 1001 -g root -d /app -s /sbin/nologin floci \
    && mkdir -p /app/data \
    && chown -R 1001:root /app \
    && chmod -R g+rwX /app

WORKDIR /app
COPY --from=build --chown=1001:root /src/floci/target/quarkus-app/ /app/quarkus-app/
COPY --from=source --chmod=755 /src/floci/docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=source --chmod=755 /src/floci/docker/localstack-parity.sh /usr/local/bin/localstack-parity.sh
COPY --from=source --chmod=755 /src/floci/docker/healthcheck.sh /usr/local/bin/healthcheck.sh
COPY --chmod=755 local-jwt-command.sh /usr/local/bin/local-jwt-command.sh

VOLUME /app/data
EXPOSE 4566
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bash", "/usr/local/bin/local-jwt-command.sh"]
