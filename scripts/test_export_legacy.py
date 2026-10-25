# SPDX-License-Identifier: AGPL-3.0-only
import pathlib
import tempfile
import unittest
from export_legacy import ExportError, collect, write_package


class Fixture:
    def rows(self, path, empty_404=False):
        if path == "patient":
            return [{"uuid": "patient-one", "pid": "1", "pubpid": "SIM-001", "fname": "Avery", "lname": "Synthetic", "DOB": "1990-01-01", "phone_home": "synthetic"}]
        if path.endswith("/allergy"):
            return [{"id": "10", "title": "Synthetic allergy", "reaction": "Synthetic reaction"}]
        if path.endswith("/encounter"):
            return [{"encounter": "20", "date": "2020-01-01", "provider_id": "99"}]
        if path.endswith("/soap_note"):
            return [{"id": "30", "subjective": "Original historical note", "user": "source-author"}]
        return []


class ExportTest(unittest.TestCase):
    def test_export_retains_source_fields_and_patient_references(self):
        package = collect(Fixture(), "stable-source", "snapshot-1", ["allergy"])
        self.assertEqual(package["manifest"]["expected_counts"], {"allergy": 1, "encounter": 1, "patient": 1, "soap_note": 1})
        self.assertEqual(package["items"][0]["data"]["mrn"], "SIM-001")
        self.assertEqual(package["items"][0]["source_data"]["phone_home"], "synthetic")
        self.assertEqual(package["items"][-1]["patient_source_id"], "patient-one")
        self.assertEqual(package["items"][-1]["source_data"]["user"], "source-author")
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "export.json"
            write_package(package, file)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_package(package, file)

    def test_missing_identity_stops_export(self):
        class Missing(Fixture):
            def rows(self, path, empty_404=False):
                if path == "patient":
                    return [{"fname": "Incomplete"}]
                return []
        with self.assertRaises(ExportError):
            collect(Missing(), "stable-source", "snapshot", [])


if __name__ == "__main__":
    unittest.main()
