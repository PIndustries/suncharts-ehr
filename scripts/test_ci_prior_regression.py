import unittest

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


if __name__ == "__main__":
    unittest.main()
