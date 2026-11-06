import re
import unittest
from pathlib import Path

from scripts.connect_migrate_shards import SHARD_COUNT, partition


ROOT = Path(__file__).resolve().parents[1]


def source_tests() -> list[str]:
    source = (ROOT / "tests/connect_migrate.rs").read_text()
    return re.findall(
        r"#\[(?:tokio::)?test\]\s*(?:async\s+)?fn\s+([a-zA-Z0-9_]+)", source
    )


class ReleaseRegressionShardTests(unittest.TestCase):
    def test_every_connect_migrate_test_is_assigned_exactly_once(self):
        expected = source_tests()
        self.assertGreater(len(expected), SHARD_COUNT)
        shards = partition(expected)
        assigned = [name for shard in shards for name in shard]
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(set(assigned), set(expected))
        self.assertTrue(all(shards), shards)
        self.assertLessEqual(max(map(len, shards)) - min(map(len, shards)), 1)

    def test_assignment_is_stable_and_six_way(self):
        expected = source_tests()
        self.assertEqual(SHARD_COUNT, 6)
        self.assertEqual(partition(expected), partition(reversed(expected)))

    def test_release_gate_requires_every_parallel_lane(self):
        workflow = (ROOT / ".github/workflows/full-regression.yml").read_text()
        self.assertIn("shard: [0, 1, 2, 3, 4, 5]", workflow)
        self.assertIn(
            "needs: [rust-quality, rust-regression, connect-migrate-shards, script-contracts]",
            workflow,
        )
        self.assertIn('test "$SHARD_RESULT" = success', workflow)
        publisher = (ROOT / ".github/workflows/publish-image.yml").read_text()
        self.assertRegex(publisher, r"publish_amd64:\s+needs: full_regression")


if __name__ == "__main__":
    unittest.main()
