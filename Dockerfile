# syntax=docker/dockerfile:1.7
ARG RUST_IMAGE="rust:1.89-bookworm@sha256:948f9b08a66e7fe01b03a98ef1c7568292e07ec2e4fe90d88c07bb14563c84ff"
ARG RUNTIME_IMAGE="debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3"
ARG DEBIAN_SNAPSHOT="20250910T000000Z"
FROM ${RUST_IMAGE} AS builder
ARG DEBIAN_SNAPSHOT
WORKDIR /src
RUN printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --no-install-recommends clang cmake perl pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=suncharts-ehr-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=suncharts-ehr-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=suncharts-ehr-target,target=/src/target,sharing=locked \
    cargo build --locked --release \
    && install -D -m 0755 target/release/suncharts-engine /out/suncharts-engine

FROM ${RUNTIME_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.title="SunCharts EHR" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/PIndustries/suncharts-ehr"
RUN printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 suncharts \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /var/lib/suncharts suncharts \
    && install -d -o suncharts -g suncharts -m 0700 /var/lib/suncharts/private
COPY --from=builder /out/suncharts-engine /usr/local/bin/suncharts-engine
USER 10001:10001
WORKDIR /var/lib/suncharts
ENV ENGINE_BIND=0.0.0.0:8090 \
    ENGINE_CREDENTIAL_KEY_FILE=/var/lib/suncharts/private/provider-master.key
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8090/ready || exit 1
ENTRYPOINT ["/usr/local/bin/suncharts-engine"]
