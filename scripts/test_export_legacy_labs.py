# SPDX-License-Identifier: AGPL-3.0-only
import csv
import pathlib
import tempfile
import unittest
from export_legacy import ExportError
from export_legacy_labs import collect_labs


class LabsExportTest(unittest.TestCase):
    def fixture(self, root, broken=False):
        tables = {
            'procedure_order': [{'procedure_order_id': '10', 'patient_id': '1', 'clinical_hx': 'Synthetic reason'}],
            'procedure_order_code': [{'procedure_order_id': '10', 'procedure_order_seq': '1', 'procedure_name': 'Synthetic panel', 'procedure_code': 'TEST'}],
            'procedure_report': [{'procedure_report_id': '20', 'procedure_order_id': '10', 'procedure_order_seq': '1', 'specimen_num': 'SYN-1'}],
            'procedure_result': [{'procedure_result_id': '30', 'procedure_report_id': '99' if broken else '20', 'result': '4.2', 'result_data_type': 'N', 'units': 'mmol/L', 'original_field': 'preserved'}]
        }
        for name, data in tables.items():
            with (pathlib.Path(root) / (name + '.csv')).open('w', newline='') as file:
                writer = csv.DictWriter(file, fieldnames=data[0].keys())
                writer.writeheader()
                writer.writerows(data)
        return {'manifest': {'source_instance': 'synthetic', 'source_revision': 'old', 'consistency': 'read_only_export'}, 'items': [{'kind': 'patient', 'source_id': 'patient-uuid', 'source_data': {'pid': '1'}, 'data': {}}]}

    def test_relationships_and_original_fields_survive(self):
        with tempfile.TemporaryDirectory() as root:
            package = collect_labs(self.fixture(root), root, 'snapshot')
            self.assertEqual(package['manifest']['expected_counts'], {'patient': 1, 'lab_order': 1, 'lab_result': 1})
            report = package['items'][-1]
            self.assertEqual(report['patient_source_id'], 'patient-uuid')
            self.assertEqual(report['source_data']['source_order_id'], 'procedure_order/10')
            self.assertEqual(report['source_data']['results'][0]['original_field'], 'preserved')

    def test_missing_relationship_stops_entire_conversion(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ExportError):
                collect_labs(self.fixture(root, True), root, 'snapshot')


if __name__ == '__main__':
    unittest.main()
