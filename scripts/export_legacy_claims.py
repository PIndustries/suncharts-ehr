#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Append same-snapshot source system claim CSVs and explicit ERA document evidence.
No submission states, balances, payments or claim control aliases are inferred.
"""
import argparse
import collections
import csv
import json
import pathlib
from export_legacy import ExportError, write_package
from export_legacy_labs import rows, identifier


def transaction_slices(raw):
    parts, cursor, start, env, group = [], 0, None, None, None
    element, terminator, component = '*', '~', ':'
    bare_controls, envelope_controls = set(), set()
    while cursor < len(raw):
        while cursor < len(raw) and raw[cursor].isspace():
            cursor += 1
        if cursor == len(raw):
            break
        if raw.startswith('ISA', cursor):
            if env or start is not None or len(raw)-cursor < 106:
                raise ExportError('Incomplete or nested ISA')
            element, terminator, component = raw[cursor+3], raw[cursor+105], raw[cursor+104]
            if len({element, terminator, component}) != 3 or any(c.isalnum() or c.isspace() for c in (element, terminator, component)):
                raise ExportError('Invalid ISA separators')
        end = raw.find(terminator, cursor)
        if end < 0:
            raise ExportError('Unterminated ERA segment')
        end += 1
        f = raw[cursor:end-1].split(element)
        if f[0] == 'ISA':
            if len(f) != 17 or f[12] != '00501' or f[15] not in ('T', 'P') or tuple(f[i] for i in (6, 8, 13)) in envelope_controls:
                raise ExportError('Invalid or duplicate interchange control')
            envelope_controls.add(tuple(f[i] for i in (6, 8, 13)))
            env = dict(control=f[13], usage=f[15], groups=0, seen=set())
        elif f[0] == 'GS':
            if not env or group or start is not None or len(f) < 9 or f[1] != 'HP' or not f[8].startswith('005010X221') or f[6] in env['seen']:
                raise ExportError('Invalid functional group')
            env['seen'].add(f[6])
            group = dict(control=f[6], count=0, seen=set())
        elif f[0] == 'ST':
            if start is not None or len(f) < 3 or f[1] != '835' or not f[2] or (env and not group):
                raise ExportError('Invalid transaction start')
            seen = group['seen'] if group else bare_controls
            if f[2] in seen:
                raise ExportError('Duplicate transaction control')
            seen.add(f[2])
            start, control = cursor, f[2]
        elif f[0] == 'SE':
            if start is None or len(f) < 3 or f[2] != control:
                raise ExportError('Transaction control mismatch')
            text = raw[start:end]
            segments = [s.strip().split(element) for s in text.split(terminator) if s.strip()]
            if f[1] != str(len(segments)) or len(parts) >= 20:
                raise ExportError('Transaction count or batch limit exceeded')
            parts.append(dict(position=len(parts), start=start, end=end, interchange_control=env['control'] if env else None,
                group_control=group['control'] if group else None, transaction_control=control, usage=env['usage'] if env else None,
                segments=segments, component=component))
            if group:
                group['count'] += 1
            start = None
        elif f[0] == 'GE':
            if start is not None or not env or not group or len(f) < 3 or f[1] != str(group['count']) or f[2] != group['control'] or not group['count']:
                raise ExportError('Group count/control mismatch')
            env['groups'] += 1
            group = None
        elif f[0] == 'IEA':
            if start is not None or not env or group or len(f) < 3 or f[1] != str(env['groups']) or f[2] != env['control'] or not env['groups']:
                raise ExportError('Interchange count/control mismatch')
            env = None
            element, terminator, component = '*', '~', ':'
        elif start is None:
            raise ExportError('Content outside transaction')
        cursor = end
    if env or group or start is not None or not parts:
        raise ExportError('Incomplete ERA file')
    return parts


def settlement_index(raw):
    transactions, provider, reversals = [], [], []
    for part in transaction_slices(raw):
        pairs, reverse_rows, row_index = [], [], -1
        for fields in part['segments']:
            if fields[0] == 'CLP':
                row_index += 1
                if len(fields) >= 8 and fields[2] == '22':
                    reverse_rows.append(dict(row_index=row_index, control_number=fields[1], payer_control_number=fields[7],
                        charged_text=fields[3], paid_text=fields[4], patient_responsibility_text=fields[5]))
            if fields[0] == 'PLB':
                if len(fields) < 5 or len(fields) > 15 or (len(fields)-3) % 2:
                    raise ExportError('Incomplete PLB pair in source ERA')
                for i in range(3, len(fields), 2):
                    code, _, reference = fields[i].partition(part['component'])
                    pairs.append(dict(index=len(pairs), provider_id=fields[1], fiscal_date=fields[2],
                        reason_code=code, reference=reference, amount_text=fields[i+1]))
        if len(pairs) > 120 or row_index >= 30:
            raise ExportError('Transaction exceeds supported review profile')
        transaction = {k: v for k, v in part.items() if k not in ('segments', 'component')}
        transaction.update(provider_adjustments=pairs, claim_reversals=reverse_rows)
        transactions.append(transaction)
        provider.extend(dict(p, transaction_position=part['position']) for p in pairs)
        reversals.extend(dict(r, transaction_position=part['position']) for r in reverse_rows)
    return dict(transactions=transactions, provider_adjustments=provider, claim_reversals=reversals,
        policy='Historical evidence only. Keep original file, source order, controls, exact reversal/correction identities and migrated AR references. No collection or ledger posting inferred.')


def collect_claims(base, directory, revision, era_documents=None):
    package = json.loads(json.dumps(base))
    if not package.get('manifest') or not isinstance(package.get('items'), list):
        raise ExportError('Base package requires manifest and items')
    if any(r['kind'] in ('claim', 'remittance') for r in package['items']):
        raise ExportError('Base package already contains claims or remittances')
    patients = {}
    for item in package['items']:
        if item['kind'] == 'patient':
            pid = identifier(item['source_data'], 'pid')
            if pid in patients:
                raise ExportError('Duplicate source patient identity')
            patients[pid] = item['source_id']
    payers = {r['source_id'] for r in package['items'] if r['kind'] == 'insurance_company'}
    bills = {r['source_id']: r['patient_source_id'] for r in package['items'] if r['kind'] == 'billing'}
    seen = set()
    for row in rows(directory, 'claims'):
        pid, encounter = (identifier(row, k) for k in ('patient_id', 'encounter_id'))
        version = str(row.get('version', '')).strip()
        if not version.isascii() or not version.isdigit() or len(version) > 10 or int(version) > 4294967295:
            raise ExportError('Invalid source claim version')
        key = f'claims/{pid}/{encounter}/{version}'
        billing_id = f'billing/{pid}/{encounter}'
        payer = str(row.get('payer_id', '')).strip()
        if key in seen or pid not in patients or bills.get(billing_id) != patients[pid]:
            raise ExportError('Duplicate claim or unmapped patient/billing encounter')
        if payer not in ('0',) and 'insurance_companies/' + payer not in payers:
            raise ExportError('Claim references an unexported payer')
        seen.add(key)
        package['items'].append({'kind': 'claim', 'source_id': key, 'patient_source_id': patients[pid],
            'data': {'title': 'Source insurance claim'}, 'source_data': {'claim': row,
                'source_billing_id': billing_id, 'source_payer_id': None if payer == '0' else 'insurance_companies/' + payer,
                'mapping_policy': 'Review posted account, payer and original claim control identity. Source status, process fields and version remain historical; native reconciliation creates a draft only.'}})
    # Caller provides explicit local files, never dereference source process_file paths.
    for item in era_documents or []:
        key = identifier(item, 'source_id')
        payer = identifier(item, 'payer_source_id')
        if key in seen or payer not in payers:
            raise ExportError('Duplicate remittance or unexported payer')
        if set(item) - {'source_id', 'payer_source_id', 'path', 'provider', 'provider_report_id', 'source_ar_session_id', 'source_ar_activity_ids', 'transaction_payer_source_ids'}:
            raise ExportError('Unsupported ERA manifest property; never include credentials or live cursor state')
        provider = item.get('provider')
        report_id = item.get('provider_report_id')
        if provider is not None or report_id is not None:
            if provider != 'claim_md' or not isinstance(report_id, str) or not report_id.isascii() or not report_id.isdigit() or len(report_id) > 20 or int(report_id) > 2**64 - 1:
                raise ExportError('Claim.MD ERA mapping requires a bounded numeric provider_report_id')
        seen.add(key)
        raw = pathlib.Path(item['path']).read_bytes().decode('ascii')
        if len(raw.encode('ascii')) > 48000 or not raw.strip():
            raise ExportError('ERA evidence requires a bounded ASCII 835 file')
        mapping = settlement_index(raw)
        transaction_payers = item.get('transaction_payer_source_ids')
        if transaction_payers is not None and (not isinstance(transaction_payers, list) or len(transaction_payers) != len(mapping['transactions']) or any(not isinstance(x, str) or x not in payers for x in transaction_payers)):
            raise ExportError('Map each transaction to an exported payer in source order')
        source_refs = item.get('source_ar_activity_ids', [])
        if not isinstance(source_refs, list) or len(source_refs) > 100 or any(not isinstance(x, str) for x in source_refs) or len(set(source_refs)) != len(source_refs):
            raise ExportError('Bounded distinct source AR activity references required')
        refs = source_refs + ([item['source_ar_session_id']] if item.get('source_ar_session_id') else [])
        known_refs = {r['source_id'] for r in package['items'] if r['kind'] == 'transaction'}
        if any(not isinstance(x, str) or x not in known_refs for x in refs):
            raise ExportError('ERA AR reference is not present in the frozen financial package')
        package['items'].append({'kind': 'remittance', 'source_id': key, 'patient_source_id': None,
            'data': {'title': 'Source ERA document'}, 'source_data': {'format': 'x12_835',
                'original_text': raw, 'source_payer_id': payer, 'settlement_mapping': mapping, 'source_ar_references': refs, 'transaction_source_payer_ids': transaction_payers,
                'mapping_policy': 'Native payer selection, parsing, claim matching and contractual credit review required. No automatic posting.'}})
        if provider:
            package['items'][-1]['source_data'].update({'provider': provider, 'provider_report_id': report_id,
                'provider_report_kind': 'era835', 'automation_policy': 'historical_only_no_live_cursor_no_automatic_posting'})
    if len(package['items']) > 100000:
        raise ExportError('Combined package exceeds supported job size')
    package['manifest']['source_revision'] = revision
    package['manifest']['expected_counts'] = dict(collections.Counter(r['kind'] for r in package['items']))
    package['manifest'].setdefault('limitations', []).extend([
        'Operator attested one frozen snapshot across base, financial, claim CSVs and selected ERA files; not independently verified.',
        'Claim rows and explicitly supplied ERA bytes are source evidence. No submitted claim, native balance, control alias or remittance posting inferred.',
        'Missing original documents, live clearinghouse configuration, automatic reconstruction of prior payments, full 835 profiles and production cutover remain pending.'
    ])
    return package


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('base-package', 'ehi-dir', 'source-revision', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--era-documents', help='JSON array of source_id, payer_source_id and explicit local path')
    p.add_argument('--confirm-same-snapshot', required=True, action='store_true')
    args = p.parse_args()
    try:
        with open(args.base_package) as file:
            base = json.load(file)
        documents = None
        if args.era_documents:
            with open(args.era_documents) as file:
                documents = json.load(file)
        write_package(collect_claims(base, args.ehi_dir, args.source_revision, documents), args.out)
    except (ExportError, OSError, ValueError, KeyError, TypeError, csv.Error):
        p.exit(1, 'Claims export failed. Review source headers, relationships and bounded original ERA documents.\n')
    print('Claim and remittance source package written for review.')


if __name__ == '__main__':
    main()
