# Floci 2.2.0にローカル検証用のOAuth refresh修正を適用し、公式と同じnativeイメージを作る。
FROM ubuntu:noble AS source

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/floci
RUN git clone --depth 1 --branch 2.2.0 https://github.com/floci-io/floci.git . \
    && test "$(git rev-parse HEAD)" = "17c99047b92b5729b356f3584513cd6ed598b8a9"

COPY floci-refresh.patch /tmp/floci-refresh.patch
RUN git apply --check /tmp/floci-refresh.patch \
    && git apply /tmp/floci-refresh.patch

# 上流docker/Dockerfile.nativeと同じbuilder、Maven、native-image引数を使う。
FROM quay.io/quarkus/ubi-quarkus-mandrel-builder-image:jdk-25 AS build
USER root
WORKDIR /src/floci

# Builderのsystem MavenはQuarkusに対して古いため、上流と同じ検証済みMavenを入れる。
RUN curl -fsSL -o /tmp/maven.tar.gz https://archive.apache.org/dist/maven/maven-3/3.9.12/binaries/apache-maven-3.9.12-bin.tar.gz \
    && echo "0a1be79f02466533fc1a80abbef8796e4f737c46c6574ede5658b110899942a94db634477dfd3745501c80aef9aac0d4f841d38574373f7e2d24cce89d694f70  /tmp/maven.tar.gz" | sha512sum -c - \
    && tar xzf /tmp/maven.tar.gz -C /opt \
    && rm /tmp/maven.tar.gz \
    && ln -sf /opt/apache-maven-3.9.12/bin/mvn /usr/local/bin/mvn

COPY --from=source /src/floci/ /src/floci/
# native-imageのheap上限を固定する。未指定だとDocker VMのメモリを使い切り、並行buildと競合して失敗する。
ARG NATIVE_IMAGE_XMX=6g
# -H:-AOTSingleCallsiteInlineはaarch64でのBranchTargetOutOfBoundsException回避（上流と同じ）。
RUN --mount=type=cache,target=/root/.m2 mvn -B -DskipTests -Dnative package \
    -Dquarkus.native.native-image-xmx=${NATIVE_IMAGE_XMX} \
    -Dquarkus.native.additional-build-args-append=-H:-AOTSingleCallsiteInline

FROM registry.access.redhat.com/ubi9-micro:9.8

ENV FLOCI_VERSION=2.2.0-local-refresh.4-native \
    FLOCI_STORAGE_PERSISTENT_PATH=/app/data

# Floci公式nativeイメージと同じ起動・権限切替方式を使う。
WORKDIR /app
RUN echo 'floci:x:1001:0:Floci:/app:/sbin/nologin' >> /etc/passwd \
    && mkdir -p /app/data \
    && chown -R 1001:root /app \
    && chmod -R g+rwX /app

# Builderにzlib-staticがないためnative binaryはlibz.so.1を動的リンクする。ubi9-microには無い。
COPY --from=build /usr/lib64/libz.so.1 /usr/lib64/libz.so.1
COPY --from=build --chown=1001:root --chmod=755 /src/floci/target/*-runner /app/application
COPY --from=source --chmod=755 /src/floci/docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=source --chmod=755 /src/floci/docker/localstack-parity.sh /usr/local/bin/localstack-parity.sh
COPY --from=source --chmod=755 /src/floci/docker/healthcheck.sh /usr/local/bin/healthcheck.sh

VOLUME /app/data
EXPOSE 4566
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/application", "-Dquarkus.http.host=0.0.0.0", "-Dfloci.security.allow-unsafe-network-exposure=true"]
