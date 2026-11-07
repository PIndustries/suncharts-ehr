#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

export ENGINE_WEB_ROOT="${ENGINE_WEB_ROOT:-$repo_dir/web}"
export ENGINE_BIND="${ENGINE_BIND:-127.0.0.1:8090}"
export ENGINE_PUBLIC_URL="${ENGINE_PUBLIC_URL:-http://127.0.0.1:8090}"
if [ -z "${ENGINE_DATABASE_URL:-}" ] && [ -z "${ENGINE_DATABASE_URL_FILE:-}" ]; then
  export ENGINE_DATABASE_URL="postgres://localhost/suncharts_ehr_dev"
fi

# Keep the interactive UI loop isolated from validation target churn. This dedicated
# cache remains compact because Cargo.toml disables dev debug data and incremental
# compilation.
export CARGO_TARGET_DIR="${SUNCHARTS_DEV_TARGET_DIR:-$repo_dir/target/dev-ui}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"

printf 'SunCharts EHR local UI loop\n'
printf '  server: %s\n' "$ENGINE_PUBLIC_URL"
printf '  assets: %s (served with no-store; edit JS/CSS without rebuilding Rust)\n' "$ENGINE_WEB_ROOT"
printf '  build cache: %s\n' "$CARGO_TARGET_DIR"

if [ "${SUNCHARTS_DEV_USE_EXISTING_BINARY:-0}" = "1" ]; then
  binary="${SUNCHARTS_DEV_BINARY:-$repo_dir/target/debug/suncharts-engine}"
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
