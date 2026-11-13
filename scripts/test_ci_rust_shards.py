import json
import random
import re
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import ci_rust_shards
from scripts.ci_change_plan import SECURITY_RUST_TESTS
from scripts.ci_rust_shards import (
    FIRST_SECURITY_TEST,
    MEASURED_SECONDS,
    SECURITY_SHARD,
    UNIT_SHARD,
    ShardError,
    archive_members,
    build_plan,
    estimated_seconds,
    integration_tests,
    package,
    read_test_executables,
    shard_binaries,
    shard_ids,
    verify_built,
    verify_plan,
)


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "full-regression.yml"


def cargo_message(name, kind, executable, test=True):
    return json.dumps(
        {
            "reason": "compiler-artifact",
            "target": {"kind": [kind], "name": name},
            "profile": {"test": test},
            "executable": executable,
        }
    )


class RustShardPlanTest(unittest.TestCase):
    def test_every_test_file_runs_in_exactly_one_shard(self):
        on_disk = sorted(path.stem for path in (ROOT / "tests").glob("*.rs"))
        self.assertGreater(len(on_disk), 40)
        self.assertEqual(integration_tests(), on_disk)

        plan = build_plan(on_disk)
        assigned = [test for shard in plan.values() for test in shard]
        self.assertEqual(sorted(assigned), on_disk)
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual([UNIT_SHARD, *plan], shard_ids())
        self.assertTrue(all(plan.values()))

    def test_plan_is_deterministic(self):
        tests = integration_tests()
        expected = build_plan(tests)
        shuffled = list(tests)
        for seed in range(5):
            random.Random(seed).shuffle(shuffled)
            self.assertEqual(build_plan(shuffled), expected)

    def test_security_contracts_share_a_shard_and_authentication_runs_first(self):
        plan = build_plan(integration_tests())
        self.assertEqual(set(plan[SECURITY_SHARD]), SECURITY_RUST_TESTS)
        self.assertEqual(plan[SECURITY_SHARD][0], FIRST_SECURITY_TEST)
        self.assertEqual(FIRST_SECURITY_TEST, "partner_support_sso")

    def test_missing_security_contract_fails_the_plan(self):
        tests = [test for test in integration_tests() if test != "patient_portal"]
        with self.assertRaisesRegex(ShardError, "patient_portal"):
            build_plan(tests)

    def test_new_test_file_is_assigned_without_a_measurement(self):
        tests = [*integration_tests(), "brand_new_contract"]
        plan = build_plan(tests)
        self.assertEqual(
            sum(shard.count("brand_new_contract") for shard in plan.values()), 1
        )

    def test_unassigned_duplicate_and_unknown_tests_fail_the_guard(self):
        tests = integration_tests()
        plan = build_plan(tests)

        dropped = {shard: list(members) for shard, members in plan.items()}
        removed = dropped["1"].pop()
        with self.assertRaisesRegex(ShardError, f"not assigned.*{removed}"):
            verify_plan(tests, dropped)

        doubled = {shard: list(members) for shard, members in plan.items()}
        doubled["2"].append(plan["1"][0])
        with self.assertRaisesRegex(ShardError, "more than one shard"):
            verify_plan(tests, doubled)

        with self.assertRaisesRegex(ShardError, "do not exist"):
            verify_plan(tests[:-1], plan)

        emptied = {shard: list(members) for shard, members in plan.items()}
        emptied["3"] = []
        with self.assertRaisesRegex(ShardError, "not assigned|no tests"):
            verify_plan(tests, emptied)

    def test_built_targets_must_match_the_test_directory(self):
        tests = integration_tests()
        self.assertEqual(verify_built(tests), build_plan(tests))
        with self.assertRaisesRegex(ShardError, "did not build.*events"):
            verify_built([test for test in tests if test != "events"])
        with self.assertRaisesRegex(ShardError, "not assigned to any shard.*stray"):
            verify_built([*tests, "stray"])

    def test_nested_test_target_is_refused_instead_of_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests" / "nested").mkdir(parents=True)
            (root / "tests" / "plain.rs").write_text("")
            (root / "tests" / "nested" / "main.rs").write_text("")
            with self.assertRaisesRegex(ShardError, "nested"):
                integration_tests(root)

    def test_measurements_name_only_real_tests(self):
        self.assertEqual(sorted(set(MEASURED_SECONDS) - set(integration_tests())), [])

    def test_estimated_shards_stay_balanced(self):
        seconds = estimated_seconds(build_plan(integration_tests()))
        self.assertEqual(sorted(seconds), sorted(shard_ids()))
        general = [seconds[shard] for shard in shard_ids()[2:]]
        slowest_binary = max(MEASURED_SECONDS.values())
        self.assertLessEqual(max(general), max(slowest_binary, min(general)) + 30)

    def test_workflow_matrix_starts_every_shard(self):
        workflow = WORKFLOW.read_text()
        matrix = re.search(r"^        shard: \[(.*)\]$", workflow, re.M)
        self.assertIsNotNone(matrix)
        started = [item.strip().strip("'\"") for item in matrix.group(1).split(",")]
        self.assertEqual(started, shard_ids())
        self.assertIn("needs: rust-build", workflow)
        self.assertIn('ci_rust_shards.py members --shard "$SHARD"', workflow)
        self.assertIn('--shard "$SHARD"', workflow)
        self.assertIn("SHARD: ${{ matrix.shard }}", workflow)
        self.assertIn("fail-fast: false", workflow)
        self.assertIn("shell: bash", workflow)  # pipefail for the unpack pipe


class RustShardRunTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.built = self.root / "built"
        self.built.mkdir()
        self.log = self.root / "ran.log"
        self.tests = integration_tests()

    def executable(self, name, code=0):
        path = self.built / name
        path.write_text(f'#!/bin/sh\necho "{name} $PWD" >> "{self.log}"\nexit {code}\n')
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def messages(self, failing=(), skip=()):
        lines = [
            cargo_message("suncharts_engine", "lib", None, test=False),
            cargo_message("suncharts_engine", "lib", self.executable("lib")),
            cargo_message("suncharts-engine", "bin", self.executable("bin")),
            cargo_message("suncharts-engine", "bin", "/not/a/test", test=False),
            "not json",
        ]
        for test in self.tests:
            if test in skip:
                continue
            code = 101 if test in failing else 0
            lines.append(cargo_message(test, "test", self.executable(test, code)))
        path = self.root / "messages.jsonl"
        path.write_text("\n".join(lines) + "\n")
        return path

    def run_shard(self, output, shard):
        with mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            return ci_rust_shards.run(output, shard)

    def ran(self):
        if not self.log.exists():
            return []
        return [line.split(" ", 1)[0] for line in self.log.read_text().splitlines()]

    def test_package_then_all_shards_run_every_binary_once(self):
        output = self.root / "packaged"
        manifest = package(self.messages(), output)
        self.assertEqual(sorted(manifest["integration"]), self.tests)
        self.assertEqual(
            sorted(manifest["unit"]), ["bin-suncharts-engine", "lib-suncharts_engine"]
        )
        for shard in shard_ids():
            self.assertEqual(self.run_shard(output, shard), 0)
        self.assertEqual(sorted(self.ran()), sorted([*self.tests, "bin", "lib"]))
        # Binaries start in the package root, as they do under cargo.
        self.assertTrue(
            all(line.endswith(f" {ROOT}") for line in self.log.read_text().splitlines())
        )

    def test_security_shard_runs_authentication_first(self):
        output = self.root / "packaged"
        package(self.messages(), output)
        self.assertEqual(self.run_shard(output, SECURITY_SHARD), 0)
        self.assertEqual(self.ran()[0], FIRST_SECURITY_TEST)
        self.assertEqual(set(self.ran()), SECURITY_RUST_TESTS)

    def test_failing_binary_fails_the_shard_after_running_the_rest(self):
        plan = build_plan(self.tests)
        failing = plan["2"][0]
        output = self.root / "packaged"
        package(self.messages(failing=(failing,)), output)
        self.assertEqual(self.run_shard(output, "2"), 1)
        self.assertEqual(self.ran(), plan["2"])
        self.assertEqual(self.run_shard(output, "3"), 0)

    def test_package_refuses_a_test_cargo_did_not_build(self):
        with self.assertRaisesRegex(ShardError, "did not build.*events"):
            package(self.messages(skip=("events",)), self.root / "packaged")

    def test_package_refuses_missing_unit_tests_and_duplicates(self):
        messages = self.messages()
        lines = [
            line for line in messages.read_text().splitlines() if '"lib"' not in line
            and '"bin"' not in line
        ]
        messages.write_text("\n".join(lines) + "\n")
        with self.assertRaisesRegex(ShardError, "unit tests"):
            package(messages, self.root / "packaged")
        messages.write_text("\n".join([*lines, lines[-1]]) + "\n")
        with self.assertRaisesRegex(ShardError, "twice"):
            read_test_executables(messages)

    def test_missing_or_unlisted_binary_fails_the_shard(self):
        output = self.root / "packaged"
        manifest = package(self.messages(), output)
        plan = build_plan(self.tests)
        (output / manifest["integration"][plan["4"][-1]]).unlink()
        with self.assertRaisesRegex(ShardError, "missing"):
            self.run_shard(output, "4")
        self.assertEqual(self.ran(), [])

        del manifest["integration"][plan["5"][0]]
        with self.assertRaisesRegex(ShardError, "did not build"):
            shard_binaries(manifest, "5")
        with self.assertRaisesRegex(ShardError, "unknown shard"):
            shard_binaries(manifest, "7")

    def test_archive_members_cover_every_packaged_binary_once(self):
        output = self.root / "rust-test-binaries"
        manifest = package(self.messages(), output)
        members = [
            member for shard in shard_ids() for member in archive_members(shard)
        ]
        self.assertEqual(
            members.count("rust-test-binaries/manifest.json"), len(shard_ids())
        )
        binaries = [m for m in members if not m.endswith("manifest.json")]
        self.assertEqual(len(binaries), len(set(binaries)))
        expected = {
            "rust-test-binaries/unit",
            *(f"rust-test-binaries/{path}" for path in manifest["integration"].values()),
        }
        self.assertEqual(set(binaries), expected)
        self.assertTrue(
            all(path.startswith("unit/") for path in manifest["unit"].values())
        )


if __name__ == "__main__":
    unittest.main()
