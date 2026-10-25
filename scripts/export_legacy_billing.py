#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Preserve same-snapshot source system insurance, charge and AR CSVs for reviewed import.
No network requests, fee assumptions, active bookings, claims or ledger postings.
"""
import argparse
import collections
import csv
import json
from decimal import Decimal, InvalidOperation
from export_legacy import ExportError, write_package
from export_legacy_labs import rows, identifier, index


def exact_money(value):
    """Validate source decimal precision without binary float or changing its sign."""
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or abs(amount) > Decimal('1000000000') or amount * 100 != (amount * 100).to_integral_value():
            raise ValueError()
    except (InvalidOperation, ValueError):
        raise ExportError('Invalid source monetary precision; review original ledger') from None
    return amount


def collect_billing(base, directory, revision):
    package = json.loads(json.dumps(base))
    if not package.get('manifest') or not isinstance(package.get('items'), list):
        raise ExportError('Base package requires manifest and items')
    if any(r['kind'] in ('insurance', 'insurance_company', 'billing', 'transaction') for r in package['items']):
        raise ExportError('Base package already contains financial records; create an export without those domains')
    patients = {}
    for item in package['items']:
        if item['kind'] == 'patient':
            pid = identifier(item['source_data'], 'pid')
            if pid in patients:
                raise ExportError('Duplicate source patient identity')
            patients[pid] = item['source_id']
    companies = index(rows(directory, 'insurance_companies'), 'id')
    coverages = index(rows(directory, 'insurance_data'), 'id')
    charges = index(rows(directory, 'billing'), 'id')
    sessions = index(rows(directory, 'ar_session'), 'session_id')
    activities = rows(directory, 'ar_activity')
    grouped = collections.defaultdict(list)

    def patient(row, field='pid'):
        pid = identifier(row, field)
        if pid not in patients:
            raise ExportError('Financial row has an unmapped patient')
        return pid

    def add(kind, key, pid, title, source):
        package['items'].append({'kind': kind, 'source_id': key,
                                 'patient_source_id': None if pid is None else patients[pid],
                                 'data': {'title': title}, 'source_data': source})

    for cid, row in companies.items():
        add('insurance_company', 'insurance_companies/' + cid, None, 'Source payer', row)
    for cid, row in coverages.items():
        pid = patient(row)
        provider = str(row.get('provider', '')).strip()
        if provider not in ('', '0') and provider not in companies:
            raise ExportError('Coverage references a missing source payer')
        add('insurance', 'insurance_data/' + cid, pid, 'Source insurance coverage', row)
    for row in charges.values():
        pid = patient(row)
        encounter = identifier(row, 'encounter')
        exact_money(row['fee'])
        grouped[(pid, encounter)].append(row)
    for (pid, encounter), items in grouped.items():
        add('billing', f'billing/{pid}/{encounter}', pid, 'Source encounter charges',
            {'source_encounter_id': encounter, 'charge_lines': items,
             'mapping_policy': 'Review active flags, diagnosis-only rows, fee basis, author and prior AR before creating a draft. No native balance inferred.'})
    for session in sessions.values():
        patient(session, 'patient_id')
        for key in ('pay_total', 'global_amount'):
            if session.get(key) not in ('', None):
                exact_money(session[key])
    seen = set()
    for row in activities:
        pid, encounter = patient(row), identifier(row, 'encounter')
        sequence = identifier(row, 'sequence_no')
        key = (pid, encounter, sequence)
        if key in seen:
            raise ExportError('Duplicate AR activity identity')
        seen.add(key)
        if (pid, encounter) not in grouped:
            raise ExportError('AR activity references an unexported billing encounter')
        session_id = str(row.get('session_id', '')).strip()
        session = None
        if session_id not in ('', '0'):
            if session_id not in sessions or str(sessions[session_id]['patient_id']) != pid:
                raise ExportError('AR activity/session patient relationship requires review')
            session = sessions[session_id]
        for field in ('pay_amount', 'adj_amount'):
            exact_money(row[field])
        add('transaction', f'ar_activity/{pid}/{encounter}/{sequence}', pid, 'Source AR activity',
            {'activity': row, 'session': session, 'source_billing_id': f'billing/{pid}/{encounter}'})
    # Preserve sessions independently, including unapplied receipts; never drop them.
    for sid, session in sessions.items():
        add('transaction', 'ar_session/' + sid, str(session['patient_id']), 'Source payment session', {'session': session})
    if len(package['items']) > 100000:
        raise ExportError('Combined package exceeds supported job size')
    package['manifest']['source_revision'] = revision
    package['manifest']['expected_counts'] = dict(collections.Counter(r['kind'] for r in package['items']))
    package['manifest'].setdefault('limitations', []).extend([
        'Operator attested one frozen snapshot across base and financial EHI CSVs; not independently verified.',
        'Original insurance/payer/charge/AR rows preserved; no active coverage, posted charges, verified eligibility or native remaining balances inferred.',
        'Source fee may be a unit or line total. Staff must reconcile charge basis, reversals, unapplied receipts and prior payments before activating local billing.',
        'Claims files, ERA/EOB document bytes, clearinghouse configuration, full EHI and production cutover remain pending.'
    ])
    return package


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('base-package', 'ehi-dir', 'source-revision', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--confirm-same-snapshot', required=True, action='store_true')
    args = p.parse_args()
    try:
        with open(args.base_package) as file:
            base = json.load(file)
        package = collect_billing(base, args.ehi_dir, args.source_revision)
        write_package(package, args.out)
    except (ExportError, OSError, ValueError, KeyError, csv.Error) as error:
        p.exit(1, f'Financial export failed: {type(error).__name__}. Review headers, source relationships and monetary precision.\n')
    print(json.dumps({'counts': package['manifest']['expected_counts']}))


if __name__ == '__main__':
    main()
