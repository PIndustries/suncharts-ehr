#!/usr/bin/env python3
"""Build the bounded CI plan for a pull request or development push."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAFE_TEST = re.compile(r"^[a-z0-9_]+$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_./-]+$")

SECURITY_RUST_TESTS = {
    "connect_onboarding",
    "connect_services_workflow",
    "connect_support_attachments",
    "partner_support_sso",
    "patient_portal",
}
SECURITY_SOURCES = {
    "src/auth.rs",
    "src/browser.rs",
    "src/connect_identity.rs",
    "src/connect_services.rs",
    "src/managed_connect.rs",
    "src/oauth.rs",
    "src/partner_support.rs",
    "src/patient_portal.rs",
}
GLOBAL_UI_FILES = {
    "web/app.js",
    "web/index.html",
    "web/shell.js",
    "web/style.css",
}
UI_ALIASES = {
    "web/appointment-workflows.js": {"test_appointment_workflows_ui.cjs"},
    "web/clinical.js": {
        "test_diagnosis_links_ui.cjs",
        "test_patient_identity_ui.cjs",
        "test_rooming_ui.cjs",
        "test_visit_diagnoses_ui.cjs",
    },
    "web/connect-onboarding.js": {"test_connected_identity_ui.cjs"},
    "web/scheduling.js": {
        "test_appointment_workflows_ui.cjs",
        "test_chart_scheduling.cjs",
        "test_schedule_calendar.cjs",
        "test_week_calendar.cjs",
    },
}


def _all_ui_tests() -> set[str]:
    return {path.name for path in (ROOT / "scripts").glob("test_*.cjs")}


def _direct_rust_test(source: str) -> str | None:
    if not source.startswith("src/") or not source.endswith(".rs"):
        return None
    candidate = Path(source).stem
    return candidate if (ROOT / "tests" / f"{candidate}.rs").is_file() else None


def _direct_ui_tests(path: str) -> set[str]:
    if path in UI_ALIASES:
        return set(UI_ALIASES[path])
    if not path.startswith("web/") or Path(path).suffix not in {".css", ".html", ".js"}:
        return set()
    stem = Path(path).stem.replace("-", "_")
    return {
        candidate.name
        for candidate in (ROOT / "scripts").glob(f"test_{stem}*.cjs")
    }


def build_plan(changed_files: list[str]) -> dict[str, object]:
    files = []
    for raw_path in changed_files:
        path = raw_path.strip()
        if not path:
            continue
        if path.startswith("./"):
            path = path[2:]
        files.append(path)
    files = sorted(set(files))
    rust_changed = False
    migration_smoke = False
    rust_tests: set[str] = set()
    python_tests: set[str] = {"scripts.test_ci_change_plan"}
    ui_tests: set[str] = set()
    javascript_files: set[str] = set()
    openapi_files: set[str] = set()
    deploy_contract = False

    for path in files:
        if path == "BUILD_VERSION":
            rust_changed = True
        if (
            path in {"Cargo.toml", "Cargo.lock", "build.rs"}
            or path.startswith("src/") and path.endswith(".rs")
            or path.startswith("tests/") and path.endswith(".rs")
            or path.startswith("migrations/") and path.endswith(".sql")
        ):
            rust_changed = True
            migration_smoke = True

        if path.startswith("tests/") and path.endswith(".rs"):
            candidate = Path(path).stem
            if candidate != "migration_smoke" and (ROOT / path).is_file():
                rust_tests.add(candidate)
        direct_rust = _direct_rust_test(path)
        if direct_rust:
            rust_tests.add(direct_rust)
        if path in SECURITY_SOURCES:
            rust_tests.update(SECURITY_RUST_TESTS)

        if path in GLOBAL_UI_FILES:
            ui_tests.update(_all_ui_tests())
        else:
            ui_tests.update(_direct_ui_tests(path))
        if path.startswith("scripts/test_") and path.endswith(".cjs"):
            ui_tests.add(Path(path).name)
        if path.startswith("web/") and path.endswith(".js"):
            javascript_files.add(path)

        if path.startswith("scripts/") and path.endswith(".py"):
            name = Path(path).name
            if name.startswith("test_"):
                python_tests.add(f"scripts.{Path(path).stem}")
            else:
                candidate = ROOT / "scripts" / f"test_{name}"
                if candidate.is_file():
                    python_tests.add(f"scripts.test_{Path(path).stem}")

        if path.startswith("deploy/") or path == "Dockerfile":
            deploy_contract = True
            python_tests.add("scripts.test_deploy_artifacts")
        if path in {
            ".github/workflows/publish-image.yml",
            ".github/workflows/publish-dev-preview.yml",
            "scripts/build_release_manifest.py",
        }:
            deploy_contract = True
            python_tests.add("scripts.test_deploy_artifacts")
        if path.startswith(".github/workflows/"):
            python_tests.add("scripts.test_ci_change_plan")
            python_tests.add("scripts.test_ci_rust_shards")
        if path.startswith("tests/") and path.endswith(".rs"):
            # Adding, renaming or removing a test binary changes the release
            # shard plan; catch a broken plan here, not on the release tag.
            python_tests.add("scripts.test_ci_rust_shards")
        if path.startswith("api/") and path.endswith(".json"):
            openapi_files.add(path)

    for test in rust_tests:
        if not SAFE_TEST.fullmatch(test):
            raise ValueError(f"unsafe Rust test target: {test}")
    for path in (*ui_tests, *javascript_files, *openapi_files):
        if not SAFE_PATH.fullmatch(path):
            raise ValueError(f"unsafe CI path: {path}")

    return {
        "changed_files": files,
        "rust_changed": rust_changed,
        "migration_smoke": migration_smoke,
        "rust_tests": sorted(rust_tests),
        "python_tests": sorted(python_tests),
        "ui_tests": [f"scripts/{name}" for name in sorted(ui_tests)],
        "javascript_files": sorted(javascript_files),
        "openapi_files": sorted(openapi_files),
        "deploy_contract": deploy_contract,
    }


def changed_between(base: str, head: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMRD", base, head],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.splitlines()


def write_github_outputs(plan: dict[str, object], destination: Path) -> None:
    values = {
        "rust_changed": str(plan["rust_changed"]).lower(),
        "migration_smoke": str(plan["migration_smoke"]).lower(),
        "rust_tests": " ".join(plan["rust_tests"]),
        "python_tests": " ".join(plan["python_tests"]),
        "ui_tests": " ".join(plan["ui_tests"]),
        "javascript_files": " ".join(plan["javascript_files"]),
        "openapi_files": " ".join(plan["openapi_files"]),
        "deploy_contract": str(plan["deploy_contract"]).lower(),
        "plan": json.dumps(plan, separators=(",", ":")),
    }
    with destination.open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    plan = build_plan(changed_between(args.base, args.head))
    print(json.dumps(plan, indent=2))
    output = args.github_output or (
        Path(os.environ["GITHUB_OUTPUT"]) if os.environ.get("GITHUB_OUTPUT") else None
    )
    if output:
        write_github_outputs(plan, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
