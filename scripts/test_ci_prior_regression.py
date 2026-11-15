import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import ci_prior_regression
from scripts.ci_prior_regression import pick_run

MISSING = object()  # sentinel: omit the key from the run record entirely


def run(run_id, head_sha, event="push", conclusion="success"):
    """One candidate run; pass MISSING to drop a key entirely."""
    entry = {"id": run_id, "head_sha": head_sha, "event": event, "conclusion": conclusion}
    return {k: v for k, v in entry.items() if v is not MISSING}


class PickRunTest(unittest.TestCase):
    def test_run_on_the_same_commit_is_reused(self):
        runs = [run(101, "aaa")]
        self.assertEqual(pick_run(runs, {"aaa": "tree-1"}.get, "tree-1"), 101)

    def test_different_commit_with_the_same_tree_is_reused(self):
        runs = [run(202, "bbb"), run(201, "aaa")]
        self.assertEqual(pick_run(runs, {"bbb": "tree-1", "aaa": "tree-0"}.get, "tree-1"), 202)

    def test_newest_matching_run_wins(self):
        runs = [run(303, "ccc"), run(302, "bbb"), run(301, "aaa")]
        trees = {"ccc": "tree-9", "bbb": "tree-1", "aaa": "tree-1"}
        self.assertEqual(pick_run(runs, trees.get, "tree-1"), 302)

    def test_same_tree_but_failed_conclusion_is_not_reused(self):
        for conclusion in ("failure", "cancelled", "skipped", "", MISSING):
            runs = [run(401, "aaa", conclusion=conclusion)]
            self.assertIsNone(pick_run(runs, {"aaa": "tree-1"}.get, "tree-1"), conclusion)

    def test_only_push_and_workflow_dispatch_count(self):
        self.assertEqual(pick_run([run(501, "aaa", event="workflow_dispatch")], {"aaa": "t"}.get, "t"), 501)
        for event in ("pull_request", "schedule", "release", "", MISSING):
            runs = [run(502, "aaa", event=event)]
            self.assertIsNone(pick_run(runs, {"aaa": "t"}.get, "t"), event)

    def test_different_tree_is_not_reused(self):
        runs = [run(601, "aaa")]
        self.assertIsNone(pick_run(runs, {"aaa": "tree-2"}.get, "tree-1"))

    def test_missing_head_sha_is_skipped(self):
        runs = [run(701, ""), run(702, MISSING), run(703, "aaa")]
        self.assertIsNone(pick_run(runs[:1], {"aaa": "tree-1"}.get, "tree-1"))
        self.assertIsNone(pick_run(runs[:2], {"aaa": "tree-1"}.get, "tree-1"))
        self.assertEqual(pick_run(runs, {"aaa": "tree-1"}.get, "tree-1"), 703)

    def test_tree_lookup_that_raises_is_not_a_match_and_does_not_crash(self):
        def boom(head_sha):
            raise RuntimeError("gh api failed")

        runs = [run(801, "aaa"), run(802, "bbb")]
        self.assertEqual(pick_run(runs, boom, "tree-1"), None)

    def test_tree_lookup_returning_none_is_not_a_match(self):
        self.assertIsNone(pick_run([run(901, "aaa")], lambda _sha: None, "tree-1"))

    def test_tree_is_looked_up_once_per_distinct_commit(self):
        calls = []

        def tree_of(head_sha):
            calls.append(head_sha)
            return "tree-1" if head_sha == "bbb" else "tree-other"

        runs = [
            run(1001, "aaa"),
            run(1002, "aaa", conclusion="failure"),
            run(1003, "aaa", event="pull_request"),
            run(1004, "bbb"),
        ]
        self.assertEqual(pick_run(runs, tree_of, "tree-1"), 1004)
        self.assertEqual(sorted(calls), ["aaa", "bbb"])

    def test_tree_is_still_looked_up_once_when_every_lookup_raises(self):
        calls = []

        def boom(head_sha):
            calls.append(head_sha)
            raise RuntimeError("no such commit")

        runs = [run(1101, "aaa"), run(1102, "aaa"), run(1103, "bbb")]
        self.assertIsNone(pick_run(runs, boom, "tree-1"))
        self.assertEqual(sorted(calls), ["aaa", "bbb"])

    def test_empty_target_tree_never_matches(self):
        runs = [run(1201, "aaa")]
        for target in (None, ""):
            self.assertIsNone(pick_run(runs, {"aaa": "tree-1"}.get, target))

    def test_no_candidates_returns_none(self):
        for runs in ([], None):
            self.assertIsNone(pick_run(runs, {"aaa": "tree-1"}.get, "tree-1"))

    def test_successful_run_on_a_non_success_status_line_is_ignored(self):
        runs = [{"id": 1301, "event": "push", "conclusion": "success"}, run(1302, "aaa")]
        self.assertEqual(pick_run(runs, {"aaa": "tree-1"}.get, "tree-1"), 1302)


class MainWorkflowStepTest(unittest.TestCase):
    """The gh calls the workflow step makes, with subprocess.run patched out.

    ``gh api`` switches to POST the moment a ``-f`` field appears, so the runs
    listing would be POSTed and answered with a 404. These tests pin the method
    and the query fields, and check what each outcome writes to GITHUB_OUTPUT.
    """

    TARGET_SHA = "1111111111111111111111111111111111111111"
    BRANCH_SHA = "2222222222222222222222222222222222222222"
    TARGET_TREE = "3333333333333333333333333333333333333333"
    OTHER_TREE = "4444444444444444444444444444444444444444"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "github_output"
        self.output.write_text("")
        patcher = mock.patch.dict(
            os.environ,
            {
                "GITHUB_REPOSITORY": "PIndustries/suncharts-ehr",
                "GITHUB_SHA": self.TARGET_SHA,
                "GITHUB_OUTPUT": str(self.output),
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def api_path(command):
        """The endpoint argument of a gh api command, wherever it sits."""
        after_method = command.index("GET") + 1 if "GET" in command else 3
        return command[after_method]

    def install_gh(self, trees, runs=None, records=None):
        """Answer the three kinds of call from ``trees`` (commit sha -> tree)."""

        def fake_run(command, **_kwargs):
            if records is not None:
                records.append(list(command))
            path = self.api_path(command)
            if path.endswith(f"/git/commits/{self.TARGET_SHA}"):
                body = json.dumps({"tree": {"sha": self.TARGET_TREE}})
            elif path.endswith("/actions/workflows/full-regression.yml/runs"):
                body = json.dumps({"workflow_runs": runs if runs is not None else []})
            elif "/git/commits/" in path:
                sha = path.rsplit("/", 1)[1]
                body = json.dumps({"tree": {"sha": trees.get(sha)}})
            else:  # pragma: no cover - guards against a path nobody asked for
                raise AssertionError(f"unexpected gh api path: {path}")
            return subprocess.CompletedProcess(command, 0, body, "")

        patcher = mock.patch.object(
            ci_prior_regression.subprocess, "run", side_effect=fake_run
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def recorded(self):
        records: list[list[str]] = []
        self.install_gh({}, records=records)
        ci_prior_regression.main()
        return records

    def test_every_call_is_an_explicit_get(self):
        records = self.recorded()
        self.assertTrue(records)
        for record in records:
            self.assertEqual(record[:4], ["gh", "api", "--method", "GET"], record)
            self.assertNotIn("POST", record)
            self.assertNotIn("-X", record)

    def test_listing_requests_only_successful_runs_newest_first(self):
        listing = next(
            record
            for record in self.recorded()
            if self.api_path(record).endswith("/actions/workflows/full-regression.yml/runs")
        )
        self.assertEqual(
            listing[4:],
            [
                "repos/PIndustries/suncharts-ehr/actions/workflows/full-regression.yml/runs",
                "-f",
                "status=success",
                "-f",
                "per_page=40",
            ],
        )

    def test_target_commit_is_read_at_the_commits_endpoint(self):
        target = next(
            record
            for record in self.recorded()
            if self.api_path(record).endswith(f"/git/commits/{self.TARGET_SHA}")
        )
        self.assertEqual(
            self.api_path(target),
            f"repos/PIndustries/suncharts-ehr/git/commits/{self.TARGET_SHA}",
        )

    def test_same_tree_on_another_commit_writes_passed_true(self):
        self.install_gh(
            {self.BRANCH_SHA: self.TARGET_TREE},
            runs=[run(9001, self.BRANCH_SHA, event="workflow_dispatch")],
        )
        with mock.patch("builtins.print") as echoed:
            self.assertEqual(ci_prior_regression.main(), 0)
        self.assertEqual(self.output.read_text(), "passed=true\n")
        printed = "\n".join(call.args[0] for call in echoed.call_args_list)
        self.assertIn("Reusing successful full-regression run 9001", printed)
        self.assertIn(self.BRANCH_SHA, printed)
        self.assertIn(self.TARGET_TREE, printed)

    def test_different_tree_writes_passed_false(self):
        self.install_gh(
            {self.BRANCH_SHA: self.OTHER_TREE},
            runs=[run(9002, self.BRANCH_SHA, event="workflow_dispatch")],
        )
        with mock.patch("builtins.print"):
            self.assertEqual(ci_prior_regression.main(), 0)
        self.assertEqual(self.output.read_text(), "passed=false\n")

    def test_missing_gh_writes_passed_false_and_exits_zero(self):
        patcher = mock.patch.object(
            ci_prior_regression.subprocess,
            "run",
            side_effect=FileNotFoundError("gh"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        with mock.patch("builtins.print") as echoed:
            self.assertEqual(ci_prior_regression.main(), 0)
        self.assertEqual(self.output.read_text(), "passed=false\n")
        printed = "\n".join(call.args[0] for call in echoed.call_args_list)
        self.assertIn("could not check for a reusable full-regression run", printed)


if __name__ == "__main__":
    unittest.main()
