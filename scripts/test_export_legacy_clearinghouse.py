# SPDX-License-Identifier: AGPL-3.0-only
import csv
import json
import pathlib
import tempfile
import unittest
from export_legacy import ExportError
from export_legacy_clearinghouse import collect_clearinghouse


class ClearinghouseExportTest(unittest.TestCase):
    def fixture(self, root):
        row = {'id': '7', 'name': 'Synthetic Partner', 'x12_sender_id': 'SYN-SEND', 'x12_receiver_id': 'SYN-RECV', 'x12_isa15': 'P', 'x12_sftp_pass': 'SECRET-MUST-NOT-EXPORT', 'x12_client_secret': 'ANOTHER-SECRET', 'future_secret': 'FUTURE-SECRET'}
        with (pathlib.Path(root) / 'x12_partners.csv').open('w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=row.keys())
            w.writeheader()
            w.writerow(row)
        return {'manifest': {'source_instance': 'synthetic'}, 'items': [{'kind': 'claim', 'source_id': 'claims/1/55/2', 'source_data': {'claim': {'x12_partner_id': '7'}}}]}

    def test_no_credentials_and_exact_acknowledgment_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            raw = 'ST*999*SYN~\r\nSE*2*SYN~\r\n'
            path = pathlib.Path(root) / 'ack.999'
            path.write_bytes(raw.encode('ascii'))
            ack = {'source_id': 'ack/SYN', 'source_partner_id': 'x12_partners/7', 'source_claim_id': 'claims/1/55/2', 'format': 'x12_999', 'path': str(path)}
            package = collect_clearinghouse(base, root, 'frozen', [ack])
            self.assertNotIn('SECRET', json.dumps(package))
            self.assertEqual(package['items'][0]['source_data']['source_partner_id'], 'x12_partners/7')
            self.assertEqual(package['items'][-1]['source_data']['original_text'], raw)
            self.assertEqual(package['items'][-2]['source_data']['partner']['x12_isa15'], 'P')
            with self.assertRaises(ExportError):
                collect_clearinghouse(package, root, 'duplicate')

    def test_missing_partner_and_claim_relationships_fail(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            base['items'][0]['source_data']['claim']['x12_partner_id'] = '8'
            with self.assertRaises(ExportError):
                collect_clearinghouse(base, root, 'bad')
            base = self.fixture(root)
            with self.assertRaises(ExportError):
                collect_clearinghouse(base, root, 'bad', [{'source_id': 'ack/1', 'source_partner_id': 'x12_partners/7', 'source_claim_id': 'missing'}])

    def test_277ca_origin_is_preserved_without_activating_transport(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            raw = 'ST*277*CA01*005010X214~\r\nSE*2*CA01~\r\n'
            path = pathlib.Path(root) / 'ack.277'
            path.write_bytes(raw.encode('ascii'))
            ack = {'source_id': 'ack/CA01', 'source_partner_id': 'x12_partners/7', 'source_claim_id': 'claims/1/55/2', 'format': 'x12_277ca', 'path': str(path), 'origin': 'payer', 'endpoint': 'https://must-not-export.example', 'token': 'SECRET-MUST-NOT-EXPORT'}
            package = collect_clearinghouse(base, root, 'frozen', [ack])
            evidence = package['items'][-1]['source_data']
            self.assertEqual(evidence['original_text'], raw)
            self.assertEqual(evidence['declared_origin'], 'payer')
            self.assertEqual(evidence['source_claim_id'], 'claims/1/55/2')
            self.assertNotIn('SECRET', json.dumps(package))
            self.assertNotIn('must-not-export', json.dumps(package))
            ack['origin'] = 'unknown'
            with self.assertRaises(ExportError):
                collect_clearinghouse(base, root, 'frozen', [ack])

    def test_provider_identity_and_claimmd_json_preserve_history_without_credentials_or_cursors(self):
        with tempfile.TemporaryDirectory() as root:
            base = self.fixture(root)
            path = pathlib.Path(root) / 'source-status.json'
            raw = '{"pcn":"SOURCE-CONTROL","status":"A","senderid":"CLMMD","message":{"responseid":9,"message":"Acknowledged"}}\r\n'
            path.write_bytes(raw.encode('ascii'))
            ack = {'source_id': 'claimmd/9', 'source_partner_id': 'x12_partners/7', 'source_claim_id': 'claims/1/55/2', 'format': 'claimmd_status', 'provider': 'claim_md', 'provider_report_id': '9', 'path': str(path), 'page_token': 'DO-NOT-IMPORT-CURSOR', 'AccountKey': 'DO-NOT-IMPORT-KEY'}
            package = collect_clearinghouse(base, root, 'frozen', [ack])
            evidence = package['items'][-1]['source_data']
            self.assertEqual(evidence['original_text'], raw)
            self.assertEqual(evidence['provider'], 'claim_md')
            self.assertEqual(evidence['provider_report_id'], '9')
            self.assertNotIn('DO-NOT-IMPORT', json.dumps(package))
            path.write_text('{"pcn":"SOURCE-CONTROL","AccountKey":"DO-NOT-IMPORT"}')
            with self.assertRaises(ExportError):
                collect_clearinghouse(base, root, 'frozen', [ack])
            ack['provider'] = 'unknown'
            with self.assertRaises(ExportError):
                collect_clearinghouse(base, root, 'frozen', [ack])
