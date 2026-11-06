import unittest

from scripts.dev_clinic_acceptance import STAGES, validate_remote_payloads


class DevClinicAcceptanceTests(unittest.TestCase):
    def test_plan_covers_the_complete_clinic_journey(self):
        self.assertEqual(
            [stage.key for stage in STAGES],
            [
                "access",
                "arrival",
                "specialty",
                "pathway",
                "coordination",
                "checkout",
                "connected_services",
            ],
        )
        for stage in STAGES:
            self.assertTrue(stage.rust_targets, stage.key)
            self.assertTrue(stage.ui_fixtures, stage.key)
        connected = next(stage for stage in STAGES if stage.key == "connected_services")
        self.assertIn("test_product_naming_ui.cjs", connected.ui_fixtures)

    def test_remote_proof_accepts_exact_healthy_builds(self):
        validate_remote_payloads(
            {"build": "26.11.06.2"},
            {"build": "26.11.06.2", "ready": True},
            {"status": "ok", "version": "26.11.06.2"},
            "26.11.06.2",
            "26.11.06.2",
        )

    def test_remote_proof_rejects_stale_or_unready_ehr(self):
        with self.assertRaisesRegex(RuntimeError, "expected"):
            validate_remote_payloads(
                {"build": "26.11.06.1"},
                {"build": "26.11.06.1", "ready": True},
                {"status": "ok", "version": "26.11.06.2"},
                "26.11.06.2",
                "26.11.06.2",
            )
        with self.assertRaisesRegex(RuntimeError, "ready=true"):
            validate_remote_payloads(
                {"build": "26.11.06.2"},
                {"build": "26.11.06.2", "ready": False},
                {"status": "ok", "version": "26.11.06.2"},
                "26.11.06.2",
                "26.11.06.2",
            )


if __name__ == "__main__":
    unittest.main()
