#!/usr/bin/env python3
"""Create the release manifest later attested and attached to a GitHub Release."""

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE = re.compile(r"^ghcr\.io/pindustries/suncharts-ehr@sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
RUST_IMAGE = re.compile(r"^rust:1\.89-bookworm@sha256:[0-9a-f]{64}$")
RUNTIME_IMAGE = re.compile(r"^debian:bookworm-slim@sha256:[0-9a-f]{64}$")
CMAKE_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-reference", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tag", required=True)
    parser.add_argument("--workflow-ref", required=True)
    parser.add_argument("--rust-image", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--cmake-version", required=True)
    parser.add_argument("--cmake-x86-64-sha256", required=True)
    parser.add_argument("--cmake-aarch64-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    version = (ROOT / "BUILD_VERSION").read_text().strip()
    if args.source_tag != f"v{version}":
        raise ValueError("release tag must exactly match BUILD_VERSION")
    if not IMAGE.fullmatch(args.image_reference):
        raise ValueError("release image must use the approved GHCR repository by digest")
    if not COMMIT.fullmatch(args.source_commit):
        raise ValueError("source commit must be a full Git SHA")
    if not RUST_IMAGE.fullmatch(args.rust_image) or not RUNTIME_IMAGE.fullmatch(args.runtime_image):
        raise ValueError("release base images must use the approved repositories by digest")
    if not CMAKE_VERSION.fullmatch(args.cmake_version):
        raise ValueError("CMake version must be an exact numeric release")
    if not SHA256.fullmatch(args.cmake_x86_64_sha256) or not SHA256.fullmatch(args.cmake_aarch64_sha256):
        raise ValueError("CMake archives must use exact SHA-256 checksums")
    metadata = json.loads((ROOT / "deploy" / "release-metadata.json").read_text())
    revisions = [int(path.name.split("_", 1)[0]) for path in (ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")]
    current_revision = max(revisions, default=0)
    if metadata["schema_revision"] != current_revision:
        raise ValueError("release metadata schema_revision does not match migrations")
    if not 0 <= metadata["minimum_upgrade_schema_revision"] <= current_revision:
        raise ValueError("release minimum schema revision is invalid")
    if metadata["database_rollback_mode"] not in ("same_schema_image_only", "restore_pre_update_backup"):
        raise ValueError("release database rollback mode is invalid")
    if not metadata["channel_eligibility"] or not set(metadata["channel_eligibility"]).issubset({"preview", "stable"}):
        raise ValueError("release channel eligibility is invalid")
    manifest = {
        "contract_version": "1",
        "version": version,
        "image_reference": args.image_reference,
        "channel_eligibility": metadata["channel_eligibility"],
        "source": {"repository": "PIndustries/suncharts-ehr", "commit": args.source_commit, "tag": args.source_tag},
        "build": {
            "rust_image": args.rust_image,
            "runtime_image": args.runtime_image,
            "cmake": {
                "version": args.cmake_version,
                "x86_64_sha256": args.cmake_x86_64_sha256,
                "aarch64_sha256": args.cmake_aarch64_sha256,
            },
        },
        "database": {
            "schema_revision": current_revision,
            "minimum_upgrade_schema_revision": metadata["minimum_upgrade_schema_revision"],
            "rollback_mode": metadata["database_rollback_mode"],
        },
        "attestation": {"issuer": "https://token.actions.githubusercontent.com", "workflow_ref": args.workflow_ref},
    }
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release manifest failed: {error}")
        raise SystemExit(2)
