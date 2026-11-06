"""Guard the shared PHX/Talos runner selectors used by verification jobs."""

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_POOL = "runs-on: [self-hosted, Linux, X64]"


class RunnerPoolPolicyTests(unittest.TestCase):
    def test_verification_jobs_use_shared_linux_pool(self) -> None:
        for relative in (
            ".github/workflows/ci.yml",
            ".github/workflows/full-regression.yml",
        ):
            text = (ROOT / relative).read_text()
            selectors = [
                line.strip()
                for line in text.splitlines()
                if line.strip().startswith("runs-on:")
            ]
            self.assertTrue(selectors, relative)
            self.assertTrue(all(selector == SHARED_POOL for selector in selectors), relative)

    def test_image_publication_stays_on_isolated_hosted_runner(self) -> None:
        text = (ROOT / ".github/workflows/publish-image.yml").read_text()
        selectors = [
            line.strip()
            for line in text.splitlines()
            if line.strip().startswith("runs-on:")
        ]
        self.assertTrue(selectors)
        self.assertTrue(all(selector == "runs-on: ubuntu-latest" for selector in selectors))


if __name__ == "__main__":
    unittest.main()
