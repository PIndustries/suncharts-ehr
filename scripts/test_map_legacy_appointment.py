# SPDX-License-Identifier: AGPL-3.0-only
import unittest
from map_legacy_appointment import mapped_booking


class AppointmentMappingTests(unittest.TestCase):
    def setUp(self):
        self.row = {"pc_eventDate": "2026-11-06", "pc_startTime": "09:00:00", "pc_duration": "1800", "pc_recurrtype": "0", "pc_apptstatus": "scheduled", "pc_title": "Synthetic review"}
        self.args = dict(patient_id="00000000-0000-4000-8000-000000000001", clinician_id="00000000-0000-4000-8000-000000000002", source_history_id="00000000-0000-4000-8000-000000000003", timezone="America/Chicago", source_booked_status="scheduled", category="Follow-up", facility="Synthetic clinic", room="1", reason="Reviewed")

    def test_explicit_timezone_and_seconds(self):
        result = mapped_booking(self.row, **self.args)
        self.assertEqual(result["starts_at"], "2026-11-06T15:00:00+00:00")
        self.assertEqual(result["ends_at"], "2026-11-06T15:30:00+00:00")
        self.assertEqual(result["source_history_id"], self.args["source_history_id"])

    def test_custom_status_and_recurrence_are_not_guessed(self):
        for field, value in (("pc_apptstatus", "arrived"), ("pc_recurrtype", "1"), ("pc_alldayevent", "1"), ("pc_duration", "0")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                mapped_booking({**self.row, field: value}, **self.args)

    def test_clock_change_requires_explicit_resolution(self):
        spring = {**self.row, "pc_eventDate": "2026-03-08", "pc_startTime": "02:30:00"}
        with self.assertRaises(ValueError):
            mapped_booking(spring, **self.args)
        autumn = {**self.row, "pc_eventDate": "2026-11-01", "pc_startTime": "01:30:00"}
        with self.assertRaises(ValueError):
            mapped_booking(autumn, **self.args)
        first = mapped_booking(autumn, **self.args, fold=0)
        second = mapped_booking(autumn, **self.args, fold=1)
        self.assertNotEqual(first["starts_at"], second["starts_at"])


if __name__ == "__main__":
    unittest.main()
