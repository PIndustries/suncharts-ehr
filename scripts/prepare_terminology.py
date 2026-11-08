#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Prepare official public-use catalogs for the EHR's atomic release importer.

No patient information or credentials are read. CPT descriptors are not bundled
or retrieved. Import licensed CPT data separately under the applicable license.
"""
import argparse
from datetime import date
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.request import urlopen
import uuid
import zipfile

DATASETS = {
    "icd10cm-2027": {
        "system": "ICD-10-CM", "edition": "FY2027",
        "source_name": "CDC / NCHS ICD-10-CM FY2027 order file",
        "source_url": "https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2027/icd10cm-code-descriptions-2027.zip",
        "effective_start": "2026-10-01", "effective_end": "2027-09-30",
    },
    "hcpcs-2026-10": {
        "system": "HCPCS", "edition": "2026-10",
        "source_name": "CMS October 2026 HCPCS Level II public-use file",
        "source_url": "https://www.cms.gov/files/zip/october-2026-alpha-numeric-hcpcs-file.zip",
        "effective_start": "2026-10-01", "effective_end": "2026-12-31",
    },
}
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024


def member(archive, pattern):
    matches = [info for info in archive.infolist() if re.search(pattern, info.filename)]
    if len(matches) != 1 or matches[0].file_size > MAX_MEMBER:
        raise ValueError("Expected one bounded official source file")
    return archive.read(matches[0]).decode("utf-8-sig")


def icd_codes(text):
    result = []
    for line in text.splitlines():
        if not line.strip():
            continue
        raw, flag = line[6:13].strip(), line[14:15]
        if not re.fullmatch(r"[A-Z][A-Z0-9]{2,6}", raw) or flag not in ("0", "1"):
            raise ValueError("Unrecognized ICD-10-CM order row")
        code = raw[:3] + ("." + raw[3:] if len(raw) > 3 else "")
        display = line[77:].strip()
        if not display:
            raise ValueError("Missing ICD-10-CM description")
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


def prepare(dataset, raw):
    spec = DATASETS[dataset]
    if len(raw) > MAX_ARCHIVE:
        raise ValueError("Source archive exceeds the allowed size")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if dataset.startswith("icd10cm"):
            codes = icd_codes(member(archive, r"/icd10cm-order-2027\.txt$"))
        else:
            codes = hcpcs_codes(member(archive, r"^HCPC2026_OCT_ANWEB_[0-9]+\.txt$"), spec["effective_start"])
    if not codes or len({row["code"] for row in codes}) != len(codes):
        raise ValueError("Empty or duplicate terminology dataset")
    return {**spec, "request_id": str(uuid.uuid4()),
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "rights": "public_use", "rights_attested": True,
            "reason": "Install the named official public-use code release", "codes": codes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", choices=DATASETS)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded official ZIP")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
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
