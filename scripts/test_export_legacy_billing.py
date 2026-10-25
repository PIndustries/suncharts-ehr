# SPDX-License-Identifier: AGPL-3.0-only
import csv
import pathlib
import tempfile
import unittest
from export_legacy import ExportError
from export_legacy_billing import collect_billing, exact_money


class FinancialExportTest(unittest.TestCase):
    def fixture(self, root, mismatch=False):
        tables = {
            'insurance_companies': [{'id': '7', 'name': 'Synthetic payer'}],
            'insurance_data': [{'id': '8', 'pid': '1', 'provider': '7', 'type': 'primary', 'policy_number': 'SYN-1'}],
            'billing': [{'id': '9', 'pid': '1', 'encounter': '55', 'fee': '125.50', 'units': '2', 'code': 'SYN', 'activity': '1'}],
            'ar_session': [{'session_id': '10', 'patient_id': '2' if mismatch else '1', 'reference': 'SYN-EOB', 'pay_total': '25.00', 'global_amount': '0.00'}],
            'ar_activity': [{'pid': '1', 'encounter': '55', 'sequence_no': '1', 'session_id': '10', 'pay_amount': '25.00', 'adj_amount': '-1.25'}]
        }
        for name, data in tables.items():
            with (pathlib.Path(root) / (name + '.csv')).open('w', newline='') as file:
                w = csv.DictWriter(file, fieldnames=data[0].keys())
                w.writeheader()
                w.writerows(data)
        return {'manifest': {'source_instance': 'synthetic', 'source_revision': 'old', 'consistency': 'read_only_export'}, 'items': [{'kind': 'patient', 'source_id': 'patient-uuid', 'source_data': {'pid': '1'}, 'data': {}}]}

    def test_source_rows_and_exact_decimal_strings_survive(self):
        with tempfile.TemporaryDirectory() as root:
            p = collect_billing(self.fixture(root), root, 'frozen-snapshot')
            self.assertEqual(p['manifest']['expected_counts'], {'patient': 1, 'insurance_company': 1, 'insurance': 1, 'billing': 1, 'transaction': 2})
            billing = next(i for i in p['items'] if i['kind'] == 'billing')
            self.assertEqual(billing['source_data']['charge_lines'][0]['fee'], '125.50')
            self.assertEqual(billing['source_data']['charge_lines'][0]['units'], '2')
            activity = next(i for i in p['items'] if i['source_id'].startswith('ar_activity'))
            self.assertEqual(activity['source_data']['activity']['adj_amount'], '-1.25')
            self.assertEqual(activity['source_data']['session']['reference'], 'SYN-EOB')
            with self.assertRaises(ExportError):
                collect_billing(p, root, 'frozen-snapshot')

    def test_mismatched_financial_identity_blocks_whole_export(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ExportError):
                collect_billing(self.fixture(root, True), root, 'snapshot')

    def test_fractional_cents_and_nonfinite_money_rejected(self):
        for amount in ('1.001', 'NaN', 'Infinity', 'bad'):
            with self.subTest(amount=amount), self.assertRaises(ExportError):
                exact_money(amount)
        self.assertEqual(str(exact_money('0.10')), '0.10')
        self.assertEqual(str(exact_money('-5.25')), '-5.25')


if __name__ == '__main__':
    unittest.main()
