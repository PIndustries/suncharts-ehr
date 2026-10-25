#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Preserve nonsecret source system X12 partner identifiers and explicit acknowledgment files.
Network endpoints, passwords, login names, tokens, client IDs and secrets are excluded.
"""
import argparse
import collections
import csv
import json
import pathlib
from export_legacy import ExportError, write_package
from export_legacy_labs import rows, identifier

# Explicit allowlist: future columns are excluded unless reviewed here.
PARTNER_FIELDS = ('id', 'name', 'id_number', 'x12_sender_id', 'x12_receiver_id',
                  'processing_format', 'x12_isa05', 'x12_isa07', 'x12_isa14',
                  'x12_isa15', 'x12_gs02', 'x12_gs03', 'x12_submitter_name', 'x12_submitter_id')


def collect_clearinghouse(base, directory, revision, acknowledgments=None):
    package = json.loads(json.dumps(base))
    if not package.get('manifest') or not isinstance(package.get('items'), list):
        raise ExportError('Base package requires manifest and items')
    if any(r['kind'] in ('x12_partner', 'edi_acknowledgment') for r in package['items']):
        raise ExportError('Base already contains EDI evidence')
    partners = {}
    for row in rows(directory, 'x12_partners'):
        pid = identifier(row, 'id')
        if pid in partners:
            raise ExportError('Duplicate X12 partner identity')
        partners[pid] = {k: row[k] for k in PARTNER_FIELDS if k in row}
        package['items'].append({'kind': 'x12_partner', 'source_id': 'x12_partners/' + pid,
            'patient_source_id': None, 'data': {'title': 'Source trading partner identifiers'},
            'source_data': {'partner': partners[pid], 'mapping_policy': 'Owner must independently review identifiers and companion guide. Native profile starts in test mode; no credentials or transport configuration imported.'}})
    claims = {r['source_id'] for r in package['items'] if r['kind'] == 'claim'}
    for item in package['items']:
        if item['kind'] != 'claim':
            continue
        partner = str(item['source_data'].get('claim', {}).get('x12_partner_id', '')).strip()
        if partner not in ('', '0'):
            if partner not in partners:
                raise ExportError('Claim references an unexported X12 partner')
            item['source_data']['source_partner_id'] = 'x12_partners/' + partner
    seen = set()
    for ack in acknowledgments or []:
        key, partner = identifier(ack, 'source_id'), identifier(ack, 'source_partner_id')
        if key in seen or partner not in {'x12_partners/' + p for p in partners}:
            raise ExportError('Duplicate acknowledgment or unmapped partner')
        seen.add(key)
        claim = ack.get('source_claim_id')
        if claim and claim not in claims:
            raise ExportError('Acknowledgment references an unexported claim')
        if ack['format'] not in ('x12_999', 'x12_ta1', 'x12_277ca', 'claimmd_status'):
            raise ExportError('Unsupported acknowledgment format')
        provider = ack.get('provider')
        if provider is not None and provider not in ('stedi', 'claim_md', 'office_ally_sftp', 'availity_sftp'):
            raise ExportError('Unsupported provider mapping')
        remote_id = ack.get('provider_report_id')
        if remote_id is not None and (not isinstance(remote_id, str) or not remote_id or len(remote_id) > 200):
            raise ExportError('Invalid provider report identity')
        origin = ack.get('origin')
        if origin is not None and origin not in ('payer', 'clearinghouse'):
            raise ExportError('Acknowledgment origin must be payer or clearinghouse')
        raw = pathlib.Path(ack['path']).read_bytes().decode('utf-8' if ack['format'] == 'claimmd_status' else 'ascii')
        if not raw.strip() or len(raw.encode('utf-8')) > 48000:
            raise ExportError('Acknowledgment requires bounded ASCII evidence')
        if ack['format'] == 'claimmd_status':
            if provider != 'claim_md':
                raise ExportError('Claim.MD status requires provider identity')
            document = json.loads(raw)
            def unsafe(v):
                if isinstance(v, dict):
                    return any(k.lower() in ('accountkey', 'account_key', 'api_key', 'apikey', 'password', 'access_token', 'client_secret', 'private_key') or unsafe(value) for k, value in v.items())
                return isinstance(v, list) and any(unsafe(x) for x in v)
            if not isinstance(document, dict) or not document.get('pcn') or unsafe(document):
                raise ExportError('Export one credential-free structured claim response per record')
        package['items'].append({'kind': 'edi_acknowledgment', 'source_id': key, 'patient_source_id': None,
            'data': {'title': 'Source clearinghouse acknowledgment'}, 'source_data': {'format': ack['format'],
                'original_text': raw, 'source_partner_id': partner, 'source_claim_id': claim, 'declared_origin': origin, 'provider': provider, 'provider_report_id': remote_id,
                'mapping_policy': '277CA stages in a multi-claim inbox and requires per-row review. Historical delivery cannot queue a native send. Select the native externally delivered submission and independently verify original controls. Import never infers delivery, technical acceptance or payer acceptance.'}})
    if len(package['items']) > 100000:
        raise ExportError('Combined source package exceeds supported size')
    package['manifest']['source_revision'] = revision
    package['manifest']['expected_counts'] = dict(collections.Counter(r['kind'] for r in package['items']))
    package['manifest'].setdefault('limitations', []).extend([
        'Operator attested a single frozen snapshot across financial/claim/partner exports and explicit acknowledgment files.',
        'Only allowlisted nonsecret partner fields preserved. Credentials, endpoints and connection/enrollment state deliberately excluded.',
        'Original acknowledgment text is historical evidence. Owner partner reconciliation and exact native submission controls require independent review; no production activation or replay inferred.'
    ])
    return package


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('base-package', 'ehi-dir', 'source-revision', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--acknowledgments', help='JSON array: source_id, source_partner_id, optional source_claim_id, format, optional origin, provider, provider_report_id, explicit local path')
    p.add_argument('--confirm-same-snapshot', required=True, action='store_true')
    args = p.parse_args()
    try:
        with open(args.base_package) as f:
            base = json.load(f)
        acknowledgments = None
        if args.acknowledgments:
            with open(args.acknowledgments) as f:
                acknowledgments = json.load(f)
        write_package(collect_clearinghouse(base, args.ehi_dir, args.source_revision, acknowledgments), args.out)
    except (ExportError, OSError, ValueError, KeyError, TypeError, csv.Error):
        p.exit(1, 'EDI export failed. Review source relationships, safe partner fields and acknowledgment files.\n')
    print('Nonsecret partner and acknowledgment evidence package written for review.')


if __name__ == '__main__':
    main()
