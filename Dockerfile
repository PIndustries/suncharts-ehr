# syntax=docker/dockerfile:1.7
ARG RUST_IMAGE="rust:1.89-bookworm@sha256:948f9b08a66e7fe01b03a98ef1c7568292e07ec2e4fe90d88c07bb14563c84ff"
ARG RUNTIME_IMAGE="debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3"
ARG CMAKE_VERSION="3.31.8"
ARG CMAKE_X86_64_SHA256="630615d8e98ac33eba7fbe472626dff5c899c85af3c024585ae109166a6909d0"
ARG CMAKE_AARCH64_SHA256="609735983e3bdf24b6ab379d918458d64196fe72b98226f62dd5e9fe7b2997cc"
FROM ${RUST_IMAGE} AS builder
ARG TARGETARCH
ARG CMAKE_VERSION
ARG CMAKE_X86_64_SHA256
ARG CMAKE_AARCH64_SHA256
WORKDIR /src
# The pinned Rust image already provides the C compiler, Perl and pkg-config.
# AWS-LC additionally needs CMake. Fetch Kitware's immutable binary archive and
# verify it before extraction instead of depending on Debian snapshot mirrors at
# release time. Network failures are bounded and can never install partial tools.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) cmake_arch=x86_64; cmake_sha="${CMAKE_X86_64_SHA256}" ;; \
      arm64) cmake_arch=aarch64; cmake_sha="${CMAKE_AARCH64_SHA256}" ;; \
      *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 2 ;; \
    esac; \
    archive="cmake-${CMAKE_VERSION}-linux-${cmake_arch}.tar.gz"; \
    curl --fail --location --retry 4 --retry-all-errors \
      --connect-timeout 20 --max-time 300 \
      --output "/tmp/${archive}" \
      "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/${archive}"; \
    printf '%s  %s\n' "${cmake_sha}" "/tmp/${archive}" | sha256sum --check --strict; \
    tar --extract --gzip --file "/tmp/${archive}" --directory /opt; \
    mv "/opt/cmake-${CMAKE_VERSION}-linux-${cmake_arch}" /opt/cmake; \
    rm "/tmp/${archive}"; \
    command -v cc; \
    command -v perl; \
    command -v pkg-config; \
    /opt/cmake/bin/cmake --version
ENV PATH="/opt/cmake/bin:${PATH}"

# Compile the locked dependency graph in a source-independent layer. The real
# crate is rebuilt below, but web-only and application-source changes retain the
# expensive third-party Rust artifacts exported by BuildKit's mode=max cache.
FROM builder AS dependencies
COPY Cargo.toml Cargo.lock ./
RUN --mount=type=cache,id=suncharts-ehr-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=suncharts-ehr-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf 'pub fn dependency_cache_seed() {}\n' > src/lib.rs \
    && printf 'fn main() {}\n' > build.rs \
    && cargo build --locked --release \
    && cargo clean --release -p suncharts-engine \
    && rm -rf src build.rs

FROM dependencies AS application
COPY . .
RUN --mount=type=cache,id=suncharts-ehr-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=suncharts-ehr-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    cargo build --locked --release \
    && install -D -m 0755 target/release/suncharts-engine /out/suncharts-engine

FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.title="SunCharts EHR" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/PIndustries/suncharts-ehr"
# The digest-pinned runtime image is used exactly as published. Avoiding apt here
# removes a release-time dependency on the Debian snapshot service. The engine
# provides its own healthcheck client, and the builder supplies the pinned CA
# bundle, so the runtime does not need curl or any downloaded package layer.
RUN printf 'suncharts:x:10001:\n' >> /etc/group \
    && printf 'suncharts:x:10001:10001:SunCharts EHR:/var/lib/suncharts:/usr/sbin/nologin\n' >> /etc/passwd \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/suncharts/private
COPY --from=application /out/suncharts-engine /usr/local/bin/suncharts-engine
USER 10001:10001
WORKDIR /var/lib/suncharts
ENV ENGINE_BIND=0.0.0.0:8090 \
    ENGINE_CREDENTIAL_KEY_FILE=/var/lib/suncharts/private/provider-master.key
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/suncharts-engine", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/suncharts-engine"]
