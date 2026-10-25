# SPDX-License-Identifier: AGPL-3.0-only
import csv
import pathlib
import tempfile
import unittest
from export_legacy import ExportError
from export_legacy_claims import collect_claims


class ClaimsExportTest(unittest.TestCase):
    def fixture(self, root, pid='1'):
        row = {'patient_id': pid, 'encounter_id': '55', 'version': '2', 'payer_id': '7', 'status': '2', 'bill_process': '2', 'submitted_claim': 'Original synthetic evidence'}
        with (pathlib.Path(root) / 'claims.csv').open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=row.keys())
            writer.writeheader()
            writer.writerow(row)
        return {'manifest': {'source_instance': 'synthetic'}, 'items': [
            {'kind': 'patient', 'source_id': 'patient-1', 'source_data': {'pid': '1'}},
            {'kind': 'insurance_company', 'source_id': 'insurance_companies/7'},
            {'kind': 'billing', 'source_id': 'billing/1/55', 'patient_source_id': 'patient-1'}]}

    def test_claim_versions_and_explicit_original_era_survive(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            path = pathlib.Path(root) / 'original.835'
            raw = 'ST*835*SYN~\r\nSE*2*SYN~\r\n'
            path.write_bytes(raw.encode('ascii'))
            p = collect_claims(base, root, 'synthetic-revision', [{'source_id': 'era/SYN', 'payer_source_id': 'insurance_companies/7', 'path': str(path)}])
            claim, era = p['items'][-2:]
            self.assertEqual(claim['source_id'], 'claims/1/55/2')
            self.assertEqual(claim['source_data']['claim']['submitted_claim'], 'Original synthetic evidence')
            self.assertEqual(era['source_data']['original_text'], raw)
            self.assertIsNone(era['patient_source_id'])
            self.assertNotIn('path', era['source_data'])
            with self.assertRaises(ExportError):
                collect_claims(p, root, 'same')

    def test_wrong_patient_or_missing_payer_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root, '2')
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'bad')
            base = self.fixture(root)
            base['items'] = [r for r in base['items'] if r['kind'] != 'insurance_company']
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'bad')

    def test_duplicate_claim_identity_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            path = pathlib.Path(root) / 'claims.csv'
            text = path.read_text()
            path.write_text(text + text.splitlines()[1] + '\n')
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'bad')

    def test_claimmd_era_mapping_retains_identity_without_activating_automation(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            path = pathlib.Path(root) / 'original.835'
            path.write_bytes(b'ST*835*SYN~SE*2*SYN~')
            item = {'source_id': 'era/SYN', 'payer_source_id': 'insurance_companies/7', 'path': str(path), 'provider': 'claim_md', 'provider_report_id': '23853671'}
            source = collect_claims(base, root, 'synthetic', [item])['items'][-1]['source_data']
            self.assertEqual(source['provider_report_id'], '23853671')
            self.assertEqual(source['provider_report_kind'], 'era835')
            self.assertEqual(source['automation_policy'], 'historical_only_no_live_cursor_no_automatic_posting')
            for changed in [dict(item, provider_report_id='18446744073709551616'), dict(item, AccountKey='must-not-import'), dict(item, cursor='12')]:
                with self.assertRaises(ExportError):
                    collect_claims(base, root, 'synthetic', [changed])

    def test_plb_and_reversal_mapping_keeps_signed_source_and_frozen_ar_links(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            base['items'].append({'kind': 'transaction', 'source_id': 'ar_session/8'})
            base['items'].append({'kind': 'transaction', 'source_id': 'ar_activity/1/55/1'})
            path = pathlib.Path(root) / 'recovery.835'
            raw = 'ST*835*1~CLP*SOURCE*22*-120*-80*-20*12*SOURCE-PCN~PLB*1234567893*20261231*WO:SOURCE-PCN*-80*FB:OLD-TRACE*80~SE*4*1~\r\n'
            path.write_bytes(raw.encode('ascii'))
            item = {'source_id': 'era/recovery', 'payer_source_id': 'insurance_companies/7', 'path': str(path), 'source_ar_session_id': 'ar_session/8', 'source_ar_activity_ids': ['ar_activity/1/55/1']}
            source = collect_claims(base, root, 'frozen', [item])['items'][-1]['source_data']
            self.assertEqual(source['original_text'], raw)
            self.assertEqual(source['settlement_mapping']['provider_adjustments'][0]['amount_text'], '-80')
            self.assertEqual(source['settlement_mapping']['claim_reversals'][0]['payer_control_number'], 'SOURCE-PCN')
            self.assertEqual(source['source_ar_references'], ['ar_activity/1/55/1', 'ar_session/8'])
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'frozen', [dict(item, source_ar_session_id='ar_session/missing')])
            path.write_text(raw.replace('WO:SOURCE-PCN*-80*FB:OLD-TRACE*80', 'WO:SOURCE-PCN'))
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'frozen', [item])

    def test_multiple_transactions_keep_controls_offsets_and_per_transaction_payers(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            path = pathlib.Path(root) / 'batch.835'
            first = 'ST*835*1~CLP*SOURCE*22*-120*-80*-20*12*PCN1~PLB*1234567893*20261231*WO:PCN1*-80~SE*4*1~'
            second = 'ST*835*2~CLP*SOURCE*1*120*70*20*12*PCN2~PLB*1234567893*20261231*WO:PCN1*70~SE*4*2~'
            raw = first + '\r\n' + second
            path.write_bytes(raw.encode('ascii'))
            item = {'source_id': 'era/file', 'payer_source_id': 'insurance_companies/7', 'transaction_payer_source_ids': ['insurance_companies/7'] * 2, 'path': str(path)}
            source = collect_claims(base, root, 'frozen', [item])['items'][-1]['source_data']
            parts = source['settlement_mapping']['transactions']
            self.assertEqual(len(parts), 2)
            self.assertEqual(parts[1]['transaction_control'], '2')
            self.assertEqual(parts[1]['provider_adjustments'][0]['amount_text'], '70')
            self.assertEqual(raw[parts[1]['start']:parts[1]['end']], second)
            self.assertEqual(parts[0]['claim_reversals'][0]['row_index'], 0)
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'frozen', [dict(item, transaction_payer_source_ids=['insurance_companies/7'])])
            path.write_text(raw.replace('SE*4*2', 'SE*3*2'))
            with self.assertRaises(ExportError):
                collect_claims(base, root, 'frozen', [item])
