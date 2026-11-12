import re
import tempfile
import unittest
from pathlib import Path

from scripts.ci_change_plan import build_plan, write_github_outputs


class ChangePlanTest(unittest.TestCase):
    def test_build_version_change_compiles_without_unrelated_migration_smoke(self):
        plan = build_plan(["BUILD_VERSION"])
        self.assertTrue(plan["rust_changed"])
        self.assertFalse(plan["migration_smoke"])
        self.assertEqual(plan["rust_tests"], [])

    def test_docs_only_skips_application_builds(self):
        plan = build_plan(["docs/operations.md"])
        self.assertFalse(plan["rust_changed"])
        self.assertFalse(plan["migration_smoke"])
        self.assertEqual(plan["ui_tests"], [])
        self.assertEqual(plan["python_tests"], ["scripts.test_ci_change_plan"])

    def test_rust_module_selects_matching_integration_and_migration_smoke(self):
        plan = build_plan(["src/care_pathways.rs", "src/lib.rs"])
        self.assertTrue(plan["rust_changed"])
        self.assertTrue(plan["migration_smoke"])
        self.assertEqual(plan["rust_tests"], ["care_pathways"])

    def test_security_source_keeps_focused_security_regressions(self):
        plan = build_plan(["src/auth.rs"])
        self.assertEqual(
            plan["rust_tests"],
            [
                "connect_onboarding",
                "connect_services_workflow",
                "connect_support_attachments",
                "partner_support_sso",
                "patient_portal",
            ],
        )

    def test_scheduling_change_selects_only_scheduling_ui_contracts(self):
        plan = build_plan(["web/scheduling.js"])
        self.assertEqual(
            plan["ui_tests"],
            [
                "scripts/test_appointment_workflows_ui.cjs",
                "scripts/test_chart_scheduling.cjs",
                "scripts/test_schedule_calendar.cjs",
                "scripts/test_week_calendar.cjs",
            ],
        )
        self.assertEqual(plan["javascript_files"], ["web/scheduling.js"])

    def test_shell_change_runs_every_ui_fixture(self):
        plan = build_plan(["web/shell.js"])
        self.assertGreater(len(plan["ui_tests"]), 20)
        self.assertIn("scripts/test_patient_portal_ui.cjs", plan["ui_tests"])
        self.assertIn("scripts/test_payments_ui.cjs", plan["ui_tests"])

    def test_deployment_change_keeps_release_contract_test(self):
        plan = build_plan(["Dockerfile"])
        self.assertTrue(plan["deploy_contract"])
        self.assertIn("scripts.test_deploy_artifacts", plan["python_tests"])

    def test_publication_workflow_keeps_release_contract_test(self):
        plan = build_plan([".github/workflows/publish-image.yml"])
        self.assertEqual(
            plan["changed_files"], [".github/workflows/publish-image.yml"]
        )
        self.assertTrue(plan["deploy_contract"])
        self.assertIn("scripts.test_deploy_artifacts", plan["python_tests"])

    def test_api_json_gets_structural_validation(self):
        plan = build_plan(["api/openapi.json"])
        self.assertEqual(plan["openapi_files"], ["api/openapi.json"])

    def test_migration_smoke_is_not_scheduled_twice(self):
        plan = build_plan(["tests/migration_smoke.rs"])
        self.assertTrue(plan["migration_smoke"])
        self.assertEqual(plan["rust_tests"], [])

    def test_workflows_keep_fast_and_release_gates_separate(self):
        root = Path(__file__).resolve().parents[1]
        development = (root / ".github/workflows/ci.yml").read_text()
        release = (root / ".github/workflows/full-regression.yml").read_text()
        self.assertIn("ci_change_plan.py", development)
        self.assertIn("cargo check --locked --all-targets", development)
        self.assertIn("  verify:\n", development)
        self.assertIn("needs: [plan, fast-rust, targeted-scripts]", development)
        self.assertNotIn("cargo test --locked\n", development)
        self.assertIn("cargo test --locked\n", release)
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", release)

    def test_ci_actions_are_supply_chain_pinned(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("ci.yml", "full-regression.yml"):
            workflow = (root / ".github/workflows" / name).read_text()
            actions = [
                line.split("uses:", 1)[1].split("#", 1)[0].strip()
                for line in workflow.splitlines()
                if "uses:" in line and "./" not in line
            ]
            self.assertGreater(len(actions), 0)
            for action in actions:
                self.assertRegex(
                    action,
                    re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$"),
                )

    def test_github_outputs_are_single_line_and_shell_safe(self):
        plan = build_plan(["web/scheduling.js", "tests/care_pathways.rs"])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            write_github_outputs(plan, output)
            lines = output.read_text().splitlines()
        self.assertIn("rust_changed=true", lines)
        self.assertIn("rust_tests=care_pathways", lines)
        self.assertTrue(all("\n" not in line for line in lines))


if __name__ == "__main__":
    unittest.main()
