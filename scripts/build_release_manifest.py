#!/usr/bin/env python3
"""Create the release manifest later attested and attached to a GitHub Release.

Two kinds of manifest exist and they are deliberately incompatible:

* The production manifest (contract "1") is built only for a ``v<BUILD_VERSION>``
  tag by publish-image.yml after the full regression. It alone can carry the
  ``preview`` and ``stable`` production channels.
* The dev preview manifest (contract "dev-preview-1", ``--dev-preview``) is built
  for a commit on ``main`` by publish-dev-preview.yml without the full
  regression. It has no source tag, is eligible for the ``dev`` channel only and
  says ``production_eligible: false``, so it fails the production schema and
  every production check.
"""

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE = re.compile(r"^ghcr\.io/pindustries/suncharts-ehr@sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
RUST_IMAGE = re.compile(r"^rust:1\.89-bookworm@sha256:[0-9a-f]{64}$")
RUNTIME_IMAGE = re.compile(r"^debian:bookworm-slim@sha256:[0-9a-f]{64}$")
SNAPSHOT = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
DEV_PREVIEW_CONTRACT = "dev-preview-1"
DEV_PREVIEW_CHANNEL = "dev"
DEV_PREVIEW_BRANCH = "main"
DEV_PREVIEW_WORKFLOW = "PIndustries/suncharts-ehr/.github/workflows/publish-dev-preview.yml"
DEV_PREVIEW_WORKFLOW_REF = f"{DEV_PREVIEW_WORKFLOW}@refs/heads/{DEV_PREVIEW_BRANCH}"


def dev_preview_build_id(version: str, commit: str) -> str:
    """Unique name of one preview build: BUILD_VERSION plus the short commit."""
    return f"{version}+dev.{commit[:12]}"


def dev_preview_release_name(commit: str) -> str:
    """GitHub prerelease (and tag) that holds one preview build's assets."""
    return f"dev-{commit[:12]}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-reference", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tag")
    parser.add_argument("--dev-preview", action="store_true")
    parser.add_argument("--workflow-ref", required=True)
    parser.add_argument("--rust-image", required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--debian-snapshot", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    version = (ROOT / "BUILD_VERSION").read_text().strip()
    if args.dev_preview:
        if args.source_tag is not None:
            raise ValueError("a dev preview is built from main and never from a release tag")
        if args.workflow_ref != DEV_PREVIEW_WORKFLOW_REF:
            raise ValueError("a dev preview must be built by the dev preview workflow on main")
    else:
        if args.source_tag != f"v{version}":
            raise ValueError("release tag must exactly match BUILD_VERSION")
        if DEV_PREVIEW_WORKFLOW in args.workflow_ref:
            raise ValueError("the dev preview workflow cannot build a production release manifest")
    if not IMAGE.fullmatch(args.image_reference):
        raise ValueError("release image must use the approved GHCR repository by digest")
    if not COMMIT.fullmatch(args.source_commit):
        raise ValueError("source commit must be a full Git SHA")
    if not RUST_IMAGE.fullmatch(args.rust_image) or not RUNTIME_IMAGE.fullmatch(args.runtime_image):
        raise ValueError("release base images must use the approved repositories by digest")
    if not SNAPSHOT.fullmatch(args.debian_snapshot):
        raise ValueError("Debian snapshot must be an immutable UTC timestamp")
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
        "build": {"rust_image": args.rust_image, "runtime_image": args.runtime_image, "debian_snapshot": args.debian_snapshot},
        "database": {
            "schema_revision": current_revision,
            "minimum_upgrade_schema_revision": metadata["minimum_upgrade_schema_revision"],
            "rollback_mode": metadata["database_rollback_mode"],
        },
        "attestation": {"issuer": "https://token.actions.githubusercontent.com", "workflow_ref": args.workflow_ref},
    }
    if args.dev_preview:
        manifest["contract_version"] = DEV_PREVIEW_CONTRACT
        manifest["channel_eligibility"] = [DEV_PREVIEW_CHANNEL]
        manifest["production_eligible"] = False
        manifest["source"] = {
            "repository": "PIndustries/suncharts-ehr",
            "commit": args.source_commit,
            "branch": DEV_PREVIEW_BRANCH,
        }
        manifest["preview"] = {
            "build_id": dev_preview_build_id(version, args.source_commit),
            "release": dev_preview_release_name(args.source_commit),
            "full_regression": "not_required",
        }
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release manifest failed: {error}")
        raise SystemExit(2)
