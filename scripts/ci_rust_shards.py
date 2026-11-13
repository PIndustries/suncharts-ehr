#!/usr/bin/env python3
"""Split the release Rust regression into parallel shards without losing a test.

The release regression compiles every Rust test binary once
(``cargo test --locked --no-run``) and then runs those binaries on several
runners at the same time. This script owns the three pieces that keep that
split honest:

* ``plan``     decides which shard runs which ``tests/*.rs`` binary.
* ``package``  collects the binaries cargo built and refuses to continue when
               cargo's test targets, the files in ``tests/`` and the shard plan
               are not the same set.
* ``members``  lists the archive paths one shard has to unpack.
* ``run``      executes one shard and fails when any assigned binary is missing
               or fails.

Every integration test binary belongs to exactly one shard. The library and
binary unit tests run in the ``unit`` shard.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:  # imported as scripts.ci_rust_shards by the tests, run as a file by CI
    from scripts.ci_change_plan import SECURITY_RUST_TESTS
except ModuleNotFoundError:  # pragma: no cover - direct execution
    from ci_change_plan import SECURITY_RUST_TESTS


ROOT = Path(__file__).resolve().parents[1]
SAFE_TEST = re.compile(r"^[a-z0-9_]+$")

ARCHIVE_DIRECTORY = "rust-test-binaries"
UNIT_SHARD = "unit"
SECURITY_SHARD = "security"
GENERAL_SHARD_COUNT = 6
# The authentication boundary has always been the first Rust contract a
# release runs. It stays first in the security shard.
FIRST_SECURITY_TEST = "partner_support_sso"

# Slowest observed wall-clock seconds per binary in release runs 43305556526,
# 43355790154 and 43360108609. These only balance the shards: a missing or
# stale entry changes how long a shard takes, never whether a test runs.
DEFAULT_SECONDS = 15
MEASURED_SECONDS = {
    "access_policies": 10,
    "access_policy_dispatch": 10,
    "ai_provider_boundary": 4,
    "billing_overview": 66,
    "care_pathways": 10,
    "checkout_workflow": 16,
    "connect_migrate": 138,
    "connect_onboarding": 88,
    "connect_services_workflow": 22,
    "connect_status": 4,
    "connect_status_stream": 6,
    "connect_support_attachments": 5,
    "connect_transport_worker": 53,
    "connect_updates": 26,
    "copay_receipts": 11,
    "diagnosis_links": 21,
    "documents": 24,
    "erx_setup": 34,
    "events": 6,
    "fhir_clinical": 16,
    "fhir_clinical_writes": 16,
    "fhir_contract": 1,
    "fhir_documents": 11,
    "fhir_orders": 9,
    "fhir_practice": 13,
    "fhir_service_writes": 14,
    "fhir_writes": 18,
    "health_history": 13,
    "immunizations": 14,
    "migration_smoke": 11,
    "partner_support_sso": 7,
    "patient_demographics": 7,
    "patient_lifecycle": 9,
    "patient_portal": 18,
    "practice_admin": 24,
    "practice_billing": 4,
    "practice_fees": 10,
    "prescribing": 12,
    "previsit_access": 31,
    "previsit_intake_links": 9,
    "previsit_workflow_binding": 7,
    "recurrence_workflow": 12,
    "referral_delivery": 25,
    "referrals": 15,
    "reminder_recovery": 27,
    "reminder_workflow": 8,
    "rooming_workflow": 12,
    "secondary_claims": 11,
    "specialty_workspace": 13,
    "staff_invitations": 12,
    "sun_tools": 5,
    "terminology": 6,
    "visit_diagnoses": 14,
    "visit_workflow": 12,
    "workflow_evidence": 8,
    "workflow_native_triggers": 7,
    "workflow_upgrade_preservation": 10,
}
UNIT_SECONDS = 122


class ShardError(Exception):
    """The shard plan and the test binaries disagree."""


def shard_ids() -> list[str]:
    """Every shard the release workflow must start, in matrix order."""
    return [
        UNIT_SHARD,
        SECURITY_SHARD,
        *(str(number) for number in range(1, GENERAL_SHARD_COUNT + 1)),
    ]


def integration_tests(root: Path = ROOT) -> list[str]:
    """Integration test targets cargo discovers in ``tests/``."""
    tests_dir = root / "tests"
    names = sorted(path.stem for path in tests_dir.glob("*.rs"))
    nested = sorted(
        path.parent.name for path in tests_dir.glob("*/main.rs")
    )
    if nested:
        raise ShardError(
            "tests in a subdirectory are not assigned to a shard: "
            + ", ".join(nested)
        )
    for name in names:
        if not SAFE_TEST.fullmatch(name):
            raise ShardError(f"unsafe Rust test target: {name}")
    return names


def estimate(test: str) -> int:
    return MEASURED_SECONDS.get(test, DEFAULT_SECONDS)


def build_plan(tests: list[str]) -> dict[str, list[str]]:
    """Assign every integration test to exactly one shard, deterministically."""
    tests = sorted(tests)
    missing_security = sorted(SECURITY_RUST_TESTS - set(tests))
    if missing_security:
        raise ShardError(
            "security regression tests are missing from tests/: "
            + ", ".join(missing_security)
        )
    plan: dict[str, list[str]] = {shard: [] for shard in shard_ids()}
    del plan[UNIT_SHARD]
    plan[SECURITY_SHARD] = sorted(
        SECURITY_RUST_TESTS, key=lambda test: (test != FIRST_SECURITY_TEST, test)
    )

    general = [str(number) for number in range(1, GENERAL_SHARD_COUNT + 1)]
    load = {shard: 0 for shard in general}
    remaining = [test for test in tests if test not in SECURITY_RUST_TESTS]
    # Longest first into the least loaded shard; names break every tie so the
    # same tests/ directory always produces the same plan.
    for test in sorted(remaining, key=lambda test: (-estimate(test), test)):
        shard = min(general, key=lambda shard: (load[shard], int(shard)))
        plan[shard].append(test)
        load[shard] += estimate(test)
    verify_plan(tests, plan)
    return plan


def verify_plan(tests: list[str], plan: dict[str, list[str]]) -> None:
    """Fail unless every test is assigned to one shard and one shard only."""
    assigned = [test for shard in plan.values() for test in shard]
    duplicates = sorted({test for test in assigned if assigned.count(test) > 1})
    if duplicates:
        raise ShardError(
            "tests assigned to more than one shard: " + ", ".join(duplicates)
        )
    unassigned = sorted(set(tests) - set(assigned))
    if unassigned:
        raise ShardError(
            "tests not assigned to any shard: " + ", ".join(unassigned)
        )
    unknown = sorted(set(assigned) - set(tests))
    if unknown:
        raise ShardError(
            "shards name tests that do not exist: " + ", ".join(unknown)
        )
    empty = sorted(shard for shard, members in plan.items() if not members)
    if empty:
        raise ShardError("shards with no tests: " + ", ".join(empty))


def estimated_seconds(plan: dict[str, list[str]]) -> dict[str, int]:
    seconds = {UNIT_SHARD: UNIT_SECONDS}
    for shard, members in plan.items():
        seconds[shard] = sum(estimate(test) for test in members)
    return seconds


def read_test_executables(messages: Path) -> dict[str, dict[str, str]]:
    """Read the test executables from ``cargo test --no-run`` JSON messages."""
    found: dict[str, dict[str, str]] = {"integration": {}, "unit": {}}
    for line in messages.read_text().splitlines():
        if not line.startswith("{"):
            continue
        message = json.loads(line)
        if message.get("reason") != "compiler-artifact":
            continue
        executable = message.get("executable")
        if not executable or not message.get("profile", {}).get("test"):
            continue
        target = message["target"]
        kinds = set(target["kind"])
        if "test" in kinds:
            group, name = "integration", target["name"]
        elif kinds & {"lib", "rlib", "bin"}:
            group, name = "unit", f"{sorted(kinds)[0]}-{target['name']}"
        else:
            raise ShardError(
                f"unexpected test target {target['name']} of kind {sorted(kinds)}"
            )
        if not SAFE_TEST.fullmatch(name.replace("-", "_")):
            raise ShardError(f"unsafe Rust test target: {name}")
        if name in found[group]:
            raise ShardError(f"cargo built the test target {name} twice")
        found[group][name] = executable
    return found


def verify_built(built: list[str], root: Path = ROOT) -> dict[str, list[str]]:
    """Fail unless cargo's test targets, tests/*.rs and the plan all agree."""
    tests = integration_tests(root)
    not_built = sorted(set(tests) - set(built))
    if not_built:
        raise ShardError(
            "tests/ files that cargo did not build as test targets: "
            + ", ".join(not_built)
        )
    not_planned = sorted(set(built) - set(tests))
    if not_planned:
        raise ShardError(
            "test targets not assigned to any shard: " + ", ".join(not_planned)
        )
    plan = build_plan(tests)
    verify_plan(sorted(built), plan)
    return plan


def package(messages: Path, output: Path) -> dict[str, dict[str, str]]:
    found = read_test_executables(messages)
    verify_built(sorted(found["integration"]))
    if not found["unit"]:
        raise ShardError("cargo built no library or binary unit tests")
    if output.exists():
        shutil.rmtree(output)
    manifest: dict[str, dict[str, str]] = {"integration": {}, "unit": {}}
    for group, executables in found.items():
        (output / group).mkdir(parents=True)
        for name, executable in sorted(executables.items()):
            relative = f"{group}/{name}"
            try:  # the binaries are large; link instead of doubling disk use
                os.link(executable, output / relative)
            except OSError:
                shutil.copy2(executable, output / relative)
            manifest[group][name] = relative
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def archive_members(shard: str, directory: str = ARCHIVE_DIRECTORY) -> list[str]:
    """Archive paths one shard needs, so it does not unpack every binary."""
    if shard not in shard_ids():
        raise ShardError(f"unknown shard: {shard}")
    members = [f"{directory}/manifest.json"]
    if shard == UNIT_SHARD:
        return [*members, f"{directory}/unit"]
    plan = build_plan(integration_tests())
    return [*members, *(f"{directory}/integration/{test}" for test in plan[shard])]


def shard_binaries(
    manifest: dict[str, dict[str, str]], shard: str, root: Path = ROOT
) -> list[tuple[str, str]]:
    """The (label, relative path) binaries a shard must run, in order."""
    if shard not in shard_ids():
        raise ShardError(f"unknown shard: {shard}")
    plan = verify_built(sorted(manifest["integration"]), root)
    if shard == UNIT_SHARD:
        if not manifest["unit"]:
            raise ShardError("no unit test binaries were packaged")
        return sorted(manifest["unit"].items())
    return [(test, manifest["integration"][test]) for test in plan[shard]]


def run(binaries: Path, shard: str) -> int:
    manifest = json.loads((binaries / "manifest.json").read_text())
    selected = shard_binaries(manifest, shard)
    for label, relative in selected:
        if not (binaries / relative).is_file():
            raise ShardError(f"test binary for {label} is missing: {relative}")
    environment = dict(os.environ, CARGO_MANIFEST_DIR=str(ROOT))
    results: list[tuple[str, int, float]] = []
    for label, relative in selected:
        print(f"::group::{label}", flush=True)
        started = time.monotonic()
        # Same working directory cargo gives a test binary: the package root.
        code = subprocess.run(
            [str((binaries / relative).resolve())], cwd=ROOT, env=environment
        ).returncode
        elapsed = time.monotonic() - started
        print("::endgroup::", flush=True)
        outcome = "ok" if code == 0 else f"FAILED (exit {code})"
        print(f"{label}: {outcome} in {elapsed:.1f}s", flush=True)
        results.append((label, code, elapsed))

    summary = ["| Test binary | Result | Seconds |", "| --- | --- | --- |"]
    summary += [
        f"| {label} | {'passed' if code == 0 else 'FAILED'} | {elapsed:.1f} |"
        for label, code, elapsed in results
    ]
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(f"### Rust shard {shard}\n\n" + "\n".join(summary) + "\n")

    failed = [label for label, code, _ in results if code != 0]
    if len(results) != len(selected):
        raise ShardError("not every assigned test binary ran")
    if failed:
        print("failed test binaries: " + ", ".join(failed), file=sys.stderr)
        return 1
    print(f"shard {shard}: {len(results)} test binaries passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="print the shard plan as JSON")
    package_parser = commands.add_parser(
        "package", help="collect and verify the binaries cargo built"
    )
    package_parser.add_argument("--messages", type=Path, required=True)
    package_parser.add_argument("--output", type=Path, required=True)
    members_parser = commands.add_parser(
        "members", help="print the archive paths one shard unpacks"
    )
    members_parser.add_argument("--shard", required=True)
    run_parser = commands.add_parser("run", help="run one shard")
    run_parser.add_argument("--binaries", type=Path, required=True)
    run_parser.add_argument("--shard", required=True)
    args = parser.parse_args()

    try:
        if args.command == "plan":
            plan = build_plan(integration_tests())
            print(
                json.dumps(
                    {
                        "shards": shard_ids(),
                        "integration": plan,
                        "estimated_seconds": estimated_seconds(plan),
                    },
                    indent=2,
                )
            )
            return 0
        if args.command == "members":
            print("\n".join(archive_members(args.shard)))
            return 0
        if args.command == "package":
            manifest = package(args.messages, args.output)
            print(
                f"packaged {len(manifest['integration'])} integration and "
                f"{len(manifest['unit'])} unit test binaries"
            )
            return 0
        return run(args.binaries, args.shard)
    except ShardError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
