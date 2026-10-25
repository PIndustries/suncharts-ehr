# SPDX-License-Identifier: AGPL-3.0-only
"""Join source system EHI laboratory CSVs into an existing SunCharts source package.
No network calls or source writes. Requires operator-confirmed same-snapshot exports.
"""
import argparse
import collections
import csv
import json
import pathlib
from export_legacy import ExportError, write_package


def rows(directory, name):
    path = pathlib.Path(directory) / (name + '.csv')
    with path.open(newline='', encoding='utf-8-sig') as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)):
            raise ExportError('CSV requires unique column headers')
        result = []
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise ExportError('Malformed EHI CSV row')
            result.append(row)
            if len(result) > 100000:
                raise ExportError('EHI table exceeds supported batch size')
        return result


def identifier(row, name):
    value = str(row.get(name, '')).strip()
    if not value or value == '0':
        raise ExportError('Missing EHI relationship identifier')
    return value


def index(items, name):
    result = {}
    for row in items:
        key = identifier(row, name)
        if key in result:
            raise ExportError('Duplicate EHI identity')
        result[key] = row
    return result


def collect_labs(base, directory, revision):
    package = json.loads(json.dumps(base))
    if not package.get('manifest') or not isinstance(package.get('items'), list):
        raise ExportError('Base package requires manifest and items')
    if any(r['kind'] in ('lab_order', 'lab_result') for r in package['items']):
        raise ExportError('Base package already contains laboratory records')
    patients = {}
    for item in package['items']:
        if item['kind'] != 'patient':
            continue
        pid = identifier(item['source_data'], 'pid')
        if pid in patients:
            raise ExportError('Duplicate patient source identity')
        patients[pid] = item['source_id']
    orders = index(rows(directory, 'procedure_order'), 'procedure_order_id')
    tests = rows(directory, 'procedure_order_code')
    reports = index(rows(directory, 'procedure_report'), 'procedure_report_id')
    results = index(rows(directory, 'procedure_result'), 'procedure_result_id')
    by_order = collections.defaultdict(list)
    seen = set()
    for test in tests:
        oid = identifier(test, 'procedure_order_id')
        seq = identifier(test, 'procedure_order_seq')
        if oid not in orders or (oid, seq) in seen:
            raise ExportError('Unmapped or duplicate ordered test relationship')
        seen.add((oid, seq))
        by_order[oid].append(test)
    by_report = collections.defaultdict(list)
    for result in results.values():
        rid = identifier(result, 'procedure_report_id')
        if rid not in reports:
            raise ExportError('Result has no source report')
        by_report[rid].append(result)
    for oid, row in orders.items():
        pid = identifier(row, 'patient_id')
        if pid not in patients or not by_order[oid]:
            raise ExportError('Order requires an exported patient and requested tests')
        package['items'].append({'kind': 'lab_order', 'source_id': 'procedure_order/' + oid,
            'patient_source_id': patients[pid], 'data': {'title': 'Source laboratory order'},
            'source_data': {'order': row, 'tests': by_order[oid]}})
    for rid, row in reports.items():
        oid = identifier(row, 'procedure_order_id')
        seq = identifier(row, 'procedure_order_seq')
        if oid not in orders or (oid, seq) not in seen or not by_report[rid]:
            raise ExportError('Report requires a source order, ordered test and result components')
        pid = identifier(orders[oid], 'patient_id')
        package['items'].append({'kind': 'lab_result', 'source_id': 'procedure_report/' + rid,
            'patient_source_id': patients[pid], 'data': {'title': 'Source laboratory report'},
            'source_data': {'source_order_id': 'procedure_order/' + oid, 'report': row, 'results': by_report[rid]}})
    if len(package['items']) > 100000:
        raise ExportError('Combined package exceeds supported job size')
    package['manifest']['source_revision'] = revision
    package['manifest']['expected_counts'] = dict(collections.Counter(r['kind'] for r in package['items']))
    package['manifest'].setdefault('limitations', []).extend([
        'Operator attested that base package and EHI CSVs share one frozen source snapshot; not independently verified.',
        'Lab source order/report/result rows preserved. Clinician reconciliation required; no source signature is newly verified.',
        'Specimen-table export, document bytes, HL7/interface configuration, delivery and complete procedure vocabulary coverage remain pending.'
    ])
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-package', required=True)
    parser.add_argument('--ehi-dir', required=True)
    parser.add_argument('--source-revision', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--confirm-same-snapshot', required=True, action='store_true')
    args = parser.parse_args()
    try:
        with open(args.base_package) as file:
            base = json.load(file)
        package = collect_labs(base, args.ehi_dir, args.source_revision)
        write_package(package, args.out)
    except (ExportError, OSError, ValueError, KeyError, csv.Error) as error:
        parser.exit(1, f'Lab export failed: {type(error).__name__}. Check CSV headers, relationships and the base package.\n')
    print(json.dumps({'counts': package['manifest']['expected_counts']}))


if __name__ == '__main__':
    main()
