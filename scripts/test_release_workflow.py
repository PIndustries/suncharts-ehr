import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _job_block(workflow: str, job: str) -> str:
    lines = workflow.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line == f"  {job}:":
            start = index
            break
    if start is None:
        raise AssertionError(f"missing job {job}")
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if line.strip() and not line.startswith("    ") and not line.startswith("      "):
            break
        block.append(line)
    return "\n".join(block)


def _condition(block: str) -> str:
    lines = block.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "if: >-":
            cond = []
            for follow in lines[index + 1 :]:
                if follow.startswith("      "):
                    cond.append(follow.strip())
                else:
                    break
            return " ".join(cond)
    raise AssertionError("job has no folded if condition")


class ReleaseWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / ".github/workflows/publish-image.yml").read_text()

    def test_prior_regression_checks_actions_history_read_only(self):
        block = _job_block(self.workflow, "prior_regression")
        self.assertIn("actions: read", block)
        self.assertIn("contents: read", block)
        self.assertIn("runs-on: ubuntu-latest", block)
        self.assertIn("timeout-minutes: 5", block)
        self.assertIn("passed: ${{ steps.", block)
        self.assertIn("GH_TOKEN: ${{ github.token }}", block)
        # The tree comparison lives in a script under scripts/, so it is unit
        # tested and reviewable rather than buried in shell quoting.
        self.assertIn("run: python3 scripts/ci_prior_regression.py", block)
        self.assertIn(
            "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
            block,
        )
        self.assertNotIn("set -e", block)
        self.assertNotIn("gh api", block)
        self.assertNotIn("head_branch", block)

    def test_prior_regression_script_never_fails_the_job(self):
        # Every failure path has to end in passed=false and exit 0, so a broken
        # gh call degrades to running the regression as before.
        source = (ROOT / "scripts/ci_prior_regression.py").read_text()
        self.assertIn("except Exception", source)
        self.assertIn("return 0", source)
        self.assertIn("_write_output(False)", source)
        self.assertIn("_write_output(True)", source)

    def test_full_regression_skips_when_prior_run_passed(self):
        block = _job_block(self.workflow, "full_regression")
        self.assertIn("needs: prior_regression", block)
        cond = _condition(block)
        self.assertIn("needs.prior_regression.outputs.passed != 'true'", cond)
        self.assertIn("github.event_name == 'push'", cond)
        self.assertIn("inputs.lane == 'amd64-release'", cond)

    def test_publish_waits_for_both_regression_paths(self):
        block = _job_block(self.workflow, "publish_amd64")
        self.assertIn(
            "needs: [prior_regression, full_regression, build_amd64]", block
        )
        cond = _condition(block)
        self.assertTrue(cond.startswith("always() &&"), cond)
        self.assertIn("needs.build_amd64.result == 'success'", cond)
        self.assertIn("needs.full_regression.result == 'success'", cond)
        self.assertIn(
            "needs.prior_regression.outputs.passed == 'true' && "
            "needs.full_regression.result == 'skipped'",
            cond,
        )
        self.assertIn("github.event_name == 'push'", cond)
        self.assertIn("inputs.lane == 'amd64-release'", cond)
        # A skipped full regression only counts when the prior run passed; the
        # success alternative alone never covers a failed or cancelled run,
        # and there is no branch that treats failure as acceptable.
        self.assertNotIn("full_regression.result == 'failure'", cond)
        self.assertNotIn("full_regression.result == 'cancelled'", cond)

    def test_downstream_jobs_do_not_require_the_skipped_regression(self):
        for name in ("publish_arm64", "community-notification"):
            block = _job_block(self.workflow, name)
            self.assertNotIn("full_regression", block, name)


if __name__ == "__main__":
    unittest.main()
