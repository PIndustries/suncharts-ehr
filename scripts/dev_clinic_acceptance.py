#!/usr/bin/env python3
"""Fast synthetic acceptance pack for the managed development clinic.

This runner deliberately avoids real patient, email, payment, or production data.
It combines the focused API/browser contracts that make up the clinic journey and
can also prove that a deployed SunCharts EHR and Connect report the expected immutable builds.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Stage:
    key: str
    label: str
    rust_targets: tuple[str, ...] = ()
    ui_fixtures: tuple[str, ...] = ()


STAGES = (
    Stage(
        "access",
        "Public booking, auto-MRN, intake, attestation and readiness",
        ("previsit_access",),
        ("test_previsit_reconciliation_ui.cjs", "test_schedule_calendar.cjs"),
    ),
    Stage(
        "arrival",
        "Arrival, rooming, encounter ownership and attributed history",
        ("rooming_workflow", "visit_workflow"),
        ("test_rooming_ui.cjs", "test_visit_diagnoses_ui.cjs"),
    ),
    Stage(
        "specialty",
        "Enableable functional-status, neurotoxin, intrathecal-pump and therapeutic-program modules",
        ("specialty_workspace",),
        ("test_specialty_workspace_ui.cjs",),
    ),
    Stage(
        "pathway",
        "Configurable care pathway, assignments, approvals and escalation",
        ("care_pathways",),
        ("test_care_pathways_ui.cjs",),
    ),
    Stage(
        "coordination",
        "Enableable referrals, reviewed delivery and care-coordination worklists",
        ("referrals", "referral_delivery"),
        ("test_referrals_ui.cjs", "test_referral_delivery_ui.cjs"),
    ),
    Stage(
        "checkout",
        "AVS, checkout, follow-up tasks and patient access",
        ("checkout_workflow", "patient_portal"),
        ("test_checkout_ui.cjs", "test_patient_portal_ui.cjs"),
    ),
    Stage(
        "connected_services",
        "Managed connection, reminders, support and payment workspace",
        ("connect_services_workflow", "connect_status"),
        ("test_connect_services_ui.cjs", "test_payments_ui.cjs", "test_product_naming_ui.cjs"),
    ),
)


def _run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def run_local() -> None:
    if not os.environ.get("TEST_DATABASE_URL"):
        raise SystemExit("TEST_DATABASE_URL must point to a disposable PostgreSQL database")
    rust_targets = tuple(dict.fromkeys(t for s in STAGES for t in s.rust_targets))
    cargo = ["cargo", "test", "--locked"]
    for target in rust_targets:
        cargo.extend(("--test", target))
    _run(cargo)
    for fixture in dict.fromkeys(f for s in STAGES for f in s.ui_fixtures):
        _run(["node", f"scripts/{fixture}"])


def _json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "SunCharts-dev-acceptance/1"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"{url} did not return a JSON object")
    return value


def validate_remote_payloads(
    version: dict[str, Any],
    ready: dict[str, Any],
    connect: dict[str, Any],
    expected_ehr: str,
    expected_connect: str,
) -> None:
    if version.get("build") != expected_ehr:
        raise RuntimeError(
            f"SunCharts EHR /version build is {version.get('build')!r}, expected {expected_ehr!r}"
        )
    if ready.get("build") != expected_ehr or ready.get("ready") is not True:
        raise RuntimeError(
            "SunCharts EHR /ready must report the expected build and ready=true; "
            f"received build={ready.get('build')!r} ready={ready.get('ready')!r}"
        )
    if connect.get("status") != "ok" or connect.get("version") != expected_connect:
        raise RuntimeError(
            "Connect /health must report status=ok and the expected build; "
            f"received status={connect.get('status')!r} version={connect.get('version')!r}"
        )


def run_remote(ehr_url: str, connect_url: str, expected_ehr: str, expected_connect: str) -> None:
    ehr = ehr_url.rstrip("/")
    connect = connect_url.rstrip("/")
    version = _json(f"{ehr}/version")
    ready = _json(f"{ehr}/ready")
    connect_health = _json(f"{connect}/health")
    validate_remote_payloads(version, ready, connect_health, expected_ehr, expected_connect)
    print(
        json.dumps(
            {
                "ehr": {"url": ehr, "build": expected_ehr, "ready": True},
                "connect": {"url": connect, "build": expected_connect, "status": "ok"},
            },
            indent=2,
        )
    )


def print_plan() -> None:
    print(
        json.dumps(
            [
                {
                    "key": stage.key,
                    "label": stage.label,
                    "rust_targets": stage.rust_targets,
                    "ui_fixtures": stage.ui_fixtures,
                }
                for stage in STAGES
            ],
            indent=2,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", action="store_true", help="run focused API and UI contracts")
    parser.add_argument("--list", action="store_true", help="print the acceptance plan")
    parser.add_argument("--ehr-url")
    parser.add_argument("--connect-url")
    parser.add_argument("--expected-ehr-build")
    parser.add_argument("--expected-connect-build")
    args = parser.parse_args()
    if args.list:
        print_plan()
    if args.local:
        run_local()
    remote = (args.ehr_url, args.connect_url, args.expected_ehr_build, args.expected_connect_build)
    if any(remote):
        if not all(remote):
            parser.error("remote proof requires both URLs and both expected builds")
        run_remote(*remote)  # type: ignore[arg-type]
    if not args.list and not args.local and not any(remote):
        parser.error("choose --list, --local, or provide the complete remote proof arguments")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
