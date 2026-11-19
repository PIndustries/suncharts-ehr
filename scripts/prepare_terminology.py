#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Prepare official public-use catalogs for the EHR's atomic release importer.

No patient information or credentials are read. CPT descriptors are not bundled
or retrieved. Import licensed CPT data separately under the applicable license.
"""
import argparse
from datetime import date
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.request import urlopen
import uuid
import zipfile

DATASETS = {
    "icd10cm-2026": {
        "system": "ICD-10-CM", "edition": "FY2026",
        "source_name": "CDC / NCHS ICD-10-CM FY2026 order file",
        "source_url": "https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2026/icd10cm-Code%20Descriptions-2026.zip",
        "effective_start": "2025-10-01", "effective_end": "2026-09-30",
    },
    "icd10cm-2027": {
        "system": "ICD-10-CM", "edition": "FY2027",
        "source_name": "CDC / NCHS ICD-10-CM FY2027 order file",
        "source_url": "https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2027/icd10cm-code-descriptions-2027.zip",
        "effective_start": "2026-10-01", "effective_end": "2027-09-30",
    },
    "icd10pcs-2027": {
        "system": "ICD-10-PCS", "edition": "FY2027",
        "source_name": "CMS ICD-10-PCS FY2027 order file",
        "source_url": "https://www.cms.gov/files/zip/2027-icd-10-pcs-order-file-long-abbreviated-titles.zip",
        "effective_start": "2026-10-01", "effective_end": "2027-09-30",
    },
    "hcpcs-2026-01": {
        "system": "HCPCS", "edition": "2026-01",
        "source_name": "CMS January 2026 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/january-2026-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2026-01-01", "effective_end": "2026-03-31",
    },
    "hcpcs-2026-04": {
        "system": "HCPCS", "edition": "2026-04",
        "source_name": "CMS April 2026 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/april-2026-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2026-04-01", "effective_end": "2026-06-30",
    },
    "hcpcs-2026-07": {
        "system": "HCPCS", "edition": "2026-07",
        "source_name": "CMS July 2026 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/july-2026-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2026-07-01", "effective_end": "2026-09-30",
    },
    "hcpcs-2026-10": {
        "system": "HCPCS", "edition": "2026-10",
        "source_name": "CMS October 2026 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/october-2026-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2026-10-01", "effective_end": "2026-12-31",
    },
    "hcpcs-2027-01": {
        "system": "HCPCS", "edition": "2027-01",
        "source_name": "CMS January 2027 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/january-2027-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2027-01-01", "effective_end": None,
    },
}
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MONTH_ABBREVIATIONS = {"01": "JAN", "04": "APR", "07": "JUL", "10": "OCT"}
MONTH_NAMES = {"01": "january", "04": "april", "07": "july", "10": "october"}
# PCS codes are alphanumeric and never use the letters I or O. Built by
# alternation so the class cannot silently collapse an intended exclusion range.
PCS_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
assert set(PCS_ALPHABET).isdisjoint("IO")
PCS_CODE = f"[{PCS_ALPHABET}]"


def source_filename(dataset):
    if dataset.startswith(("icd10cm", "icd10pcs")):
        return f"{dataset}.zip"
    year, month = dataset.split("-")[1], dataset.split("-")[2]
    return f"hcpcs-{MONTH_NAMES[month]}-{year}.zip"


def member_pattern(dataset):
    """Official source member for one dataset, chosen by its year and month."""
    if dataset.startswith("icd10cm"):
        return rf"/?icd10cm-order-{dataset.split('-')[1]}\.txt$"
    if dataset.startswith("icd10pcs"):
        return rf"/?icd10pcs_order_{dataset.split('-')[1]}\.txt$"
    year, month = dataset.split("-")[1], dataset.split("-")[2]
    abbreviation = MONTH_ABBREVIATIONS[month]
    return rf"^HCPC{year}_{abbreviation}_ANWEB(_[0-9]+)?\.txt$"


def member(archive, pattern):
    matches = [info for info in archive.infolist() if re.search(pattern, info.filename)]
    if len(matches) != 1 or matches[0].file_size > MAX_MEMBER:
        raise ValueError("Expected one bounded official source file")
    return archive.read(matches[0]).decode("utf-8-sig")


def icd_codes(text, system="ICD-10-CM"):
    result = []
    label = system
    for line in text.splitlines():
        if not line.strip():
            continue
        raw, flag = line[6:13].strip(), line[14:15]
        if system == "ICD-10-PCS":
            # PCS codes are exactly seven alphanumeric characters, exclude I/O,
            # and carry no dot. Shorter rows are 3-character root-type headings.
            pattern = f"{PCS_CODE}{{3}}(?:{PCS_CODE}{{4}})?"
        else:
            pattern = r"[A-Z][A-Z0-9]{2,6}"
        if not re.fullmatch(pattern, raw) or flag not in ("0", "1"):
            raise ValueError(f"Unrecognized {label} order row")
        if system == "ICD-10-PCS":
            code = raw
        else:
            code = raw[:3] + ("." + raw[3:] if len(raw) > 3 else "")
        display = line[77:].strip()
        if not display:
            raise ValueError(f"Missing {label} description")
        result.append({"code": code, "display": display,
                       "short_display": line[16:76].strip(), "billable": flag == "1",
                       "metadata": {"publisher_order": line[:5]}})
    return result


def cms_date(raw):
    raw = raw.strip()
    if not raw or raw == "00000000":
        return None
    if not re.fullmatch(r"[0-9]{8}", raw):
        raise ValueError("Invalid CMS date")
    return date(int(raw[:4]), int(raw[4:6]), int(raw[6:8])).isoformat()


def hcpcs_codes(text, start):
    records = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        code, record = line[:5].strip(), line[10:11]
        # Public Level II procedures only. Modifiers and any Level I / CDT
        # material are deliberately excluded from this public-use importer.
        if not re.fullmatch(r"[ABCEGHJKLMNPQRSTUV][0-9]{4}", code):
            continue
        if record == "3":
            if code in records or len(line) < 293:
                raise ValueError("Duplicate or incomplete HCPCS primary row")
            display = line[11:91].rstrip()
            if not display:
                raise ValueError("Missing HCPCS description")
            added, terminated = cms_date(line[268:276]), cms_date(line[284:292])
            records[code] = {
                "code": code, "display": display,
                "short_display": line[91:119].strip(), "billable": True,
                "active": terminated is None or terminated >= start,
                "effective_start": max(start, added or start), "effective_end": terminated,
                "metadata": {"coverage_code": line[229:230],
                             "action_effective_date": cms_date(line[276:284]),
                             "action_code": line[292:293], "added_on": added,
                             "note": "A procedure code does not establish coverage or payment."},
            }
        elif record == "4":
            if code not in records:
                raise ValueError("HCPCS continuation precedes its primary row")
            records[code]["display"] += " " + line[11:91].strip()
        else:
            raise ValueError("Unexpected HCPCS procedure record type")
    # A code terminated before this edition is retained in the original source,
    # not assigned an impossible active interval inside a newer release.
    return [row for row in records.values() if row["active"]]


def request_id(dataset):
    spec = DATASETS[dataset]
    namespace = uuid.uuid5(uuid.NAMESPACE_URL, "urn:suncharts:terminology")
    name = f"{spec['system']}/{spec['edition']}"
    return str(uuid.uuid5(namespace, name))


def build(dataset, raw, deterministic=False):
    spec = DATASETS[dataset]
    if len(raw) > MAX_ARCHIVE:
        raise ValueError("Source archive exceeds the allowed size")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        text = member(archive, member_pattern(dataset))
        if dataset.startswith(("icd10cm", "icd10pcs")):
            codes = icd_codes(text, spec["system"])
        else:
            codes = hcpcs_codes(text, spec["effective_start"])
    if not codes or len({row["code"] for row in codes}) != len(codes):
        raise ValueError("Empty or duplicate terminology dataset")
    identifier = request_id(dataset) if deterministic else str(uuid.uuid4())
    return {**spec, "request_id": identifier,
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "rights": "public_use", "rights_attested": True,
            "reason": "Install the named official public-use code release", "codes": codes}


def prepare(dataset, raw):
    return build(dataset, raw)


def catalog_filename(spec):
    return f"{spec['system'].lower()}-{spec['edition']}.json.gz"


def write_catalog(dataset, raw, directory):
    """Deterministically write one shipped catalog plus its manifest entry."""
    data = build(dataset, raw, deterministic=True)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"),
                         sort_keys=True).encode("utf-8")
    compressed = gzip.compress(payload, mtime=0)
    directory.mkdir(parents=True, exist_ok=True)
    name = catalog_filename(DATASETS[dataset])
    (directory / name).write_bytes(compressed)
    return {
        "file": name, "system": data["system"], "edition": data["edition"],
        "effective_start": data["effective_start"], "effective_end": data["effective_end"],
        "code_count": len(data["codes"]), "source_url": data["source_url"],
        "source_sha256": data["source_sha256"],
        "sha256": hashlib.sha256(compressed).hexdigest(),
    }


def prepare_all(archives, directory):
    entries = []
    for dataset in DATASETS:
        source = archives / source_filename(dataset)
        with source.open("rb") as handle:
            raw = handle.read(MAX_ARCHIVE + 1)
        entries.append(write_catalog(dataset, raw, directory))
    manifest = {"datasets": entries}
    (directory / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    for entry in entries:
        print(f"{entry['file']}: {entry['code_count']:,} codes")
    print(f"Wrote {len(entries)} catalogs and manifest.json to {directory}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", nargs="?", choices=DATASETS)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded official ZIP")
    parser.add_argument("--output", type=Path, help="Single-dataset JSON output")
    parser.add_argument("--all", action="store_true",
                        help="Prepare every shipped dataset from a source directory")
    parser.add_argument("--archives", type=Path, help="Directory of official source ZIPs")
    parser.add_argument("--dir", type=Path, help="Output catalog directory for --all")
    args = parser.parse_args()
    if args.all:
        if not args.archives or not args.dir:
            parser.error("--all requires --archives and --dir")
        prepare_all(args.archives, args.dir)
        return
    if not args.dataset or not args.output:
        parser.error("a dataset and --output are required without --all")
    if args.archive:
        with args.archive.open("rb") as source:
            raw = source.read(MAX_ARCHIVE + 1)
    else:
        with urlopen(DATASETS[args.dataset]["source_url"], timeout=45) as source:
            raw = source.read(MAX_ARCHIVE + 1)
    data = prepare(args.dataset, raw)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"Prepared {len(data['codes']):,} {data['system']} entries ({data['edition']}).")
    print(f"Source SHA-256: {data['source_sha256']}")
    print(f"Import {args.output} from SunCharts EHR Code catalogs.")


if __name__ == "__main__":
    main()
