#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

export ENGINE_WEB_ROOT="${ENGINE_WEB_ROOT:-$repo_dir/web}"
export ENGINE_BIND="${ENGINE_BIND:-127.0.0.1:8090}"
export ENGINE_PUBLIC_URL="${ENGINE_PUBLIC_URL:-http://127.0.0.1:8090}"
# A loopback EHR is a development installation. Send passwordless launches and
# onboarding to the isolated Connect development tenant, never production.
export ENGINE_CONNECT_CLOUD_URL="${ENGINE_CONNECT_CLOUD_URL:-https://dev.suncharts.app}"
export ENGINE_CONNECT_ALLOW_DEVELOPMENT="${ENGINE_CONNECT_ALLOW_DEVELOPMENT:-true}"
if [ -z "${ENGINE_DATABASE_URL:-}" ] && [ -z "${ENGINE_DATABASE_URL_FILE:-}" ]; then
  export ENGINE_DATABASE_URL="postgres://localhost/suncharts_ehr_dev"
fi

# Reuse the repository's compact development cache by default. Validation jobs can set
# SUNCHARTS_DEV_TARGET_DIR when they need an isolated target directory.
export CARGO_TARGET_DIR="${SUNCHARTS_DEV_TARGET_DIR:-$repo_dir/target}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
export CARGO_PROFILE_DEV_STRIP="${CARGO_PROFILE_DEV_STRIP:-none}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"

printf 'SunCharts EHR local UI loop\n'
printf '  server: %s\n' "$ENGINE_PUBLIC_URL"
printf '  Connect: %s (development)\n' "$ENGINE_CONNECT_CLOUD_URL"
printf '  assets: %s (served with no-store; edit JS/CSS without rebuilding Rust)\n' "$ENGINE_WEB_ROOT"
printf '  build cache: %s\n' "$CARGO_TARGET_DIR"

if [ "${SUNCHARTS_DEV_USE_EXISTING_BINARY:-0}" = "1" ]; then
  binary="${SUNCHARTS_DEV_BINARY:-$CARGO_TARGET_DIR/debug/suncharts-engine}"
  if [ ! -x "$binary" ]; then
    printf 'Existing SunCharts EHR binary is unavailable: %s\n' "$binary" >&2
    exit 1
  fi
  printf '  executable: %s (build skipped by request)\n' "$binary"
  exec "$binary"
fi

if [ -n "${SUNCHARTS_DEV_RUST_TOOLCHAIN:-}" ]; then
  exec rustup run "$SUNCHARTS_DEV_RUST_TOOLCHAIN" cargo run --locked --bin suncharts-engine
fi
exec cargo run --locked --bin suncharts-engine
