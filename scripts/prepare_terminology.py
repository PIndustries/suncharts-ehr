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
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid
import zipfile

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOGS_DIR = REPO_ROOT / "catalogs"
DATASETS_FILE = CATALOGS_DIR / "datasets.json"


def load_datasets(path=DATASETS_FILE):
    """Dataset specifications live in catalogs/datasets.json, not in code."""
    return json.loads(Path(path).read_text())["datasets"]


DATASETS = load_datasets()
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MONTH_ABBREVIATIONS = {"01": "JAN", "04": "APR", "07": "JUL", "10": "OCT"}
MONTH_NAMES = {"01": "january", "04": "april", "07": "july", "10": "october"}
NEXT_MONTH_NAMES = {"01": "april", "04": "july", "07": "october", "10": "january"}
HTTP_TIMEOUT = 45
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


def manifest_entries(directory, datasets):
    """One manifest entry per dataset named in datasets."""
    entries = []
    for spec in datasets.values():
        path = directory / catalog_filename(spec)
        data = json.loads(gzip.decompress(path.read_bytes()))
        entries.append({
            "file": path.name, "system": data["system"], "edition": data["edition"],
            "effective_start": data["effective_start"], "effective_end": data["effective_end"],
            "code_count": len(data["codes"]), "source_url": data["source_url"],
            "source_sha256": data["source_sha256"],
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    return entries


def refresh_manifest(directory, datasets=None):
    """Rewrite manifest.json deterministically from the shipped catalogs.

    The manifest covers exactly the datasets named (defaults to
    catalogs/datasets.json), so a bare run cannot pick up an untracked
    .json.gz file.
    """
    manifest = {"datasets": manifest_entries(directory,
                                             datasets if datasets is not None
                                             else load_datasets())}
    (directory / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest["datasets"]


def next_hcpcs_candidate(edition):
    """Quarter code, source URL and spec following one HCPCS edition."""
    year, month = int(edition[:4]), edition[5:]
    if month not in NEXT_MONTH_NAMES:
        raise ValueError("Unknown HCPCS quarter edition")
    nxt = NEXT_MONTH_NAMES[month]
    if nxt == "january":
        year += 1
    nxt_month = {"january": "01", "april": "04", "july": "07", "october": "10"}[nxt]
    code = f"hcpcs-{year}-{nxt_month}"
    url = f"https://www.cms.gov/files/zip/{nxt}-{year}-alpha-numeric-hcpcs-file.zip"
    spec = {
        "system": "HCPCS", "edition": f"{year}-{nxt_month}",
        "source_name": f"CMS {nxt.capitalize()} {year} HCPCS Level II public-use file",
        "source_url": url, "effective_start": f"{year}-{nxt_month}-01",
        # Editions already shipped are immutable, so a new HCPCS edition gets
        # an open end instead of closing the previous one; the server selects
        # the newest edition whose start is on or before the service date.
        "effective_end": None,
    }
    return code, url, spec


def next_icd10cm_candidate(edition):
    """Fiscal-year code, source URL and spec following one ICD-10-CM edition."""
    year = int(edition.removeprefix("FY")) + 1
    code = f"icd10cm-{year}"
    url = (f"https://ftp.cdc.gov/pub/health_statistics/nchs/publications/"
           f"ICD10CM/{year}/icd10cm-code-descriptions-{year}.zip")
    spec = {
        "system": "ICD-10-CM", "edition": f"FY{year}",
        "source_name": f"CDC / NCHS ICD-10-CM FY{year} order file",
        "source_url": url, "effective_start": f"{year - 1}-10-01",
        "effective_end": f"{year}-09-30",
    }
    return code, url, spec


def next_icd10pcs_candidate(edition):
    """Fiscal-year code, source URL and spec following one ICD-10-PCS edition."""
    year = int(edition.removeprefix("FY")) + 1
    code = f"icd10pcs-{year}"
    url = f"https://www.cms.gov/files/zip/{year}-icd-10-pcs-order-file-long-abbreviated-titles.zip"
    spec = {
        "system": "ICD-10-PCS", "edition": f"FY{year}",
        "source_name": f"CMS ICD-10-PCS FY{year} order file",
        "source_url": url, "effective_start": f"{year - 1}-10-01",
        "effective_end": f"{year}-09-30",
    }
    return code, url, spec


def newest(datasets, system):
    """Newest edition of one system, ordered by edition then dataset code."""
    editions = [(spec["edition"], code) for code, spec in datasets.items()
                if spec["system"] == system]
    if not editions:
        raise ValueError(f"No {system} dataset configured")
    return max(editions)[1]


def url_exists(url, fetch):
    """True when the official URL answers HEAD or a successful GET.

    A transport error on HEAD (network down, or a server that rejects the
    method) falls through to GET; an HTTP error such as 404 is definitive and
    is not retried.
    """
    definitive = False
    try:
        fetch("HEAD", url)
        return True
    except (HTTPError, URLError):
        definitive = True
    except OSError:
        pass
    if definitive:
        return False
    try:
        fetch("GET", url)
        return True
    except (HTTPError, URLError):
        return False


def download(url, fetch):
    raw = fetch("GET", url)
    if len(raw) > MAX_ARCHIVE:
        raise ValueError("Source archive exceeds the allowed size")
    return raw


def fetch_url(method, url):
    request = Request(url, method=method)
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return response.read(MAX_ARCHIVE + 1)


def builtin_block(entries):
    """The generated BUILTIN const in src/builtin_catalogs.rs.

    Rust cannot read manifest.json at compile time, so this list is kept in
    sync with it by the refresh job and verified by the crate's own tests.
    """
    doc = ("/// Every shipped catalog: the file name it is known by and its gzip "
           "bytes, compiled in.\n")
    lines = ["pub const BUILTIN: &[(&str, &[u8])] = &["]
    for entry in entries:
        lines.append("    (")
        lines.append(f'        "{entry["file"]}",')
        lines.append(f'        include_bytes!("../catalogs/{entry["file"]}"),')
        lines.append("    ),")
    lines.append("];")
    return doc + "\n".join(lines)


def refresh_builtin_embeds(directory, datasets):
    """Rewrite the BUILTIN const so every manifest file is embedded."""
    path = REPO_ROOT / "src" / "builtin_catalogs.rs"
    source = path.read_text()
    marker = "/// Every shipped catalog"
    doc_start = source.index(marker)
    start = source.index("pub const BUILTIN: &[(&str, &[u8])] = &[")
    end = source.index("\n];", start) + len("\n];")
    assert doc_start < start
    updated = source[:doc_start] + builtin_block(manifest_entries(directory, datasets)) + source[end:]
    if updated == source:
        return False
    path.write_text(updated)
    return True


def discover(datasets, directory, fetch, datasets_path):
    """Probe the next edition of each system; install what already exists.

    Returns the codes of newly installed datasets. Nothing is written when no
    candidate exists yet. A new HCPCS edition gets an open effective_end and
    previous editions keep theirs: shipped catalogs are immutable and the
    server selects the newest edition starting on or before the service date.
    The module-level DATASETS the builders read is updated in step with
    datasets.json, so a catalog built here uses exactly its published spec.
    """
    candidates = [
        next_hcpcs_candidate(datasets[newest(datasets, "HCPCS")]["edition"]),
        next_icd10cm_candidate(datasets[newest(datasets, "ICD-10-CM")]["edition"]),
        next_icd10pcs_candidate(datasets[newest(datasets, "ICD-10-PCS")]["edition"]),
    ]
    found, downloads = [], {}
    for code, url, spec in candidates:
        if code in datasets or not url_exists(url, fetch):
            continue
        DATASETS[code] = spec
        downloads[code] = download(url, fetch)
        write_catalog(code, downloads[code], directory)
        datasets[code] = spec
        found.append(code)
    if found:
        with datasets_path.open("w") as handle:
            json.dump({"datasets": datasets}, handle, indent=2)
            handle.write("\n")
        for code in [c for c in DATASETS if c not in datasets]:
            del DATASETS[code]
        refresh_manifest(directory, datasets)
        if directory == CATALOGS_DIR:
            refresh_builtin_embeds(directory, datasets)
    return found


def discover_cli(directory):
    """Entry point for `discover`. Prints one line; 0 when nothing was found."""
    try:
        found = discover(load_datasets(), directory, fetch_url, DATASETS_FILE)
    except Exception as error:
        print(f"Code list discovery failed: {error}")
        return 1
    if not found:
        print("No new public code list editions found.")
        return 0
    print(f"Added new public code list editions: {', '.join(found)}.")
    return 0


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
    parser.add_argument("dataset", nargs="?", choices=list(DATASETS) + ["discover"],
                        help="Dataset to prepare, or 'discover' to look for new editions")
    parser.add_argument("--archive", type=Path, help="Use an already downloaded official ZIP")
    parser.add_argument("--output", type=Path, help="Single-dataset JSON output")
    parser.add_argument("--all", action="store_true",
                        help="Prepare every shipped dataset from a source directory")
    parser.add_argument("--archives", type=Path, help="Directory of official source ZIPs")
    parser.add_argument("--dir", type=Path, help="Catalog directory (default catalogs/)")
    args = parser.parse_args()
    if args.dataset == "discover":
        directory = args.dir if args.dir else REPO_ROOT / "catalogs"
        raise SystemExit(discover_cli(directory))
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
