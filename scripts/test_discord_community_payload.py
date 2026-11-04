import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from discord_community_payload import payload  # noqa: E402


WORKFLOW = ROOT / ".github" / "workflows" / "community-notifications.yml"
PUBLISH = ROOT / ".github" / "workflows" / "publish-image.yml"


class CommunityPayloadTests(unittest.TestCase):
    def test_payload_is_bounded_and_disables_mentions(self):
        value = payload(
            "release",
            "succeeded",
            "v26.11.4.1\n@everyone\x00",
            "https://github.com/PIndustries/suncharts-ehr/releases/tag/v26.11.4.1",
        )
        encoded = json.dumps(value)
        self.assertEqual(value["allowed_mentions"], {"parse": []})
        self.assertNotIn("\n", value["embeds"][0]["description"])
        self.assertNotIn("\\u0000", encoded)
        self.assertLess(len(encoded), 2000)

    def test_rejects_non_public_or_credentialed_links(self):
        for link in (
            "https://example.test/PIndustries/suncharts-ehr",
            "https://token@github.com/PIndustries/suncharts-ehr/actions/runs/1",
            "http://github.com/PIndustries/suncharts-ehr",
            "https://github.com/PIndustries/private-repo",
        ):
            with self.assertRaises(ValueError):
                payload("image", "failed", "sha-123", link)

    def test_cli_writes_valid_json_without_interpolation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "payload.json"
            subprocess.run(
                [
                    "python3",
                    str(ROOT / "scripts" / "discord_community_payload.py"),
                    "--kind",
                    "pull_request",
                    "--status",
                    "merged",
                    "--version",
                    "PR #12\n<@123>",
                    "--url",
                    "https://github.com/PIndustries/suncharts-ehr/pull/12",
                    "--output",
                    str(output),
                ],
                check=True,
            )
            value = json.loads(output.read_text())
            self.assertEqual(value["embeds"][0]["description"], "**PR #12 <@123>** · merged")
            self.assertEqual(value["allowed_mentions"]["parse"], [])

    def test_workflows_are_secret_only_and_low_noise(self):
        combined = WORKFLOW.read_text() + PUBLISH.read_text()
        self.assertIn("secrets.DISCORD_COMMUNITY_WEBHOOK_URL", combined)
        self.assertNotIn("discord.com/api/webhooks", combined)
        self.assertNotIn("discordapp.com/api/webhooks", combined)
        self.assertIn("community-update", WORKFLOW.read_text())
        self.assertIn("github.event_name != 'schedule'", PUBLISH.read_text())


if __name__ == "__main__":
    unittest.main()
