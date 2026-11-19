#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic fixed-width fixtures; no downloaded catalogs or CPT descriptors."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "prepare_terminology", Path(__file__).with_name("prepare_terminology.py")
)
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)

ICD_MEMBER = "synthetic-release/icd10cm-order-2027.txt"
ICD26_MEMBER = "icd10cm-order-2026.txt"
PCS_MEMBER = "icd10pcs_order_2027.txt"
HCPCS_MEMBER = "HCPC2026_OCT_ANWEB_001.txt"
HCPCS_JAN27_MEMBER = "HCPC2027_JAN_ANWEB.txt"
START = "2026-10-01"


def archive(name, text):
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as value:
        value.writestr(name, text)
    return result.getvalue()


def icd_row(code, flag="1", order=1, short="Synthetic short description",
            display="Synthetic long description"):
    # CDC order layout: order 1-5, code 7-13, flag 15, short 17-76,
    # long description beginning at column 78 (one-based columns).
    return f"{order:05d} {code:<7} {flag} {short:<60} {display}"


def hcpcs_row(code="A1234", record="3", description="Synthetic procedure",
              short="Synthetic short", added="20260101", action_date="20261001",
              terminated="00000000", action="N", coverage="C"):
    # CMS ANWEB primary records use fixed columns. Continuation records retain
    # the same code/type/80-character long-description positions.
    row = list(" " * 293)
    for offset, width, value in (
        (0, 5, code), (5, 5, "00001"), (10, 1, record),
        (11, 80, description), (91, 28, short), (229, 1, coverage),
        (268, 8, added), (276, 8, action_date), (284, 8, terminated),
        (292, 1, action),
    ):
        if len(value) > width:
            raise AssertionError("Synthetic fixture field exceeds its fixed width")
        row[offset:offset + width] = value.ljust(width)
    return "".join(row)


class IcdOrderTests(unittest.TestCase):
    def test_fy2027_second_letter_category_and_billable_code(self):
        rows = "\r\n".join([
            icd_row("QA0", flag="0", order=1, display="Synthetic category heading"),
            icd_row("QA00101", flag="1", order=2, display="Synthetic billable concept"),
            "", icd_row("Z0000", flag="1", order=3),
        ])
        raw = archive(ICD_MEMBER, "\ufeff" + rows)
        prepared = importer.prepare("icd10cm-2027", raw)
        codes = prepared["codes"]
        self.assertEqual([row["code"] for row in codes], ["QA0", "QA0.0101", "Z00.00"])
        self.assertEqual([row["billable"] for row in codes], [False, True, True])
        self.assertEqual(codes[1]["display"], "Synthetic billable concept")
        self.assertEqual(codes[1]["short_display"], "Synthetic short description")
        self.assertEqual(codes[1]["metadata"]["publisher_order"], "00002")
        self.assertEqual(prepared["source_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(prepared["system"], "ICD-10-CM")
        self.assertEqual(prepared["effective_start"], START)
        self.assertEqual(prepared["effective_end"], "2027-09-30")

    def test_malformed_icd_rows_fail_closed(self):
        for row in (
            "truncated", icd_row("QA00101", flag="2"), icd_row("QA00101", flag=" "),
            icd_row("1A00101"), icd_row("QA0*101"), icd_row("QA00101", display=""),
        ):
            with self.subTest(row=row[:16]), self.assertRaises(ValueError):
                importer.prepare("icd10cm-2027", archive(ICD_MEMBER, row))

    def test_duplicate_icd_codes_are_rejected_before_import(self):
        raw = archive(ICD_MEMBER, "\n".join([
            icd_row("QA00101", order=1), icd_row("QA00101", order=2),
        ]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            importer.prepare("icd10cm-2027", raw)


class HcpcsAnwebTests(unittest.TestCase):
    def test_all_continuation_text_is_preserved_beyond_one_thousand_characters(self):
        fragments = ["Synthetic primary description"] + [
            (f"Synthetic continuation {index:02d} " + "fixture content " * 4)[:80]
            for index in range(16)
        ]
        rows = [hcpcs_row(description=fragments[0])]
        rows.extend(hcpcs_row(record="4", description=part) for part in fragments[1:])
        prepared = importer.prepare("hcpcs-2026-10", archive(HCPCS_MEMBER, "\n".join(rows)))
        self.assertEqual(len(prepared["codes"]), 1)
        code = prepared["codes"][0]
        self.assertEqual(code["display"], " ".join(part.strip() for part in fragments))
        self.assertGreater(len(code["display"]), 1000)
        self.assertEqual(code["short_display"], "Synthetic short")
        self.assertEqual(code["metadata"]["coverage_code"], "C")
        self.assertEqual(code["metadata"]["action_effective_date"], START)
        self.assertEqual(code["metadata"]["action_code"], "N")
        self.assertEqual(prepared["effective_end"], "2026-12-31")

    def test_modifiers_level_one_and_dental_material_are_excluded(self):
        # Bare code shapes are synthetic fixtures, not CPT/CDT reference data.
        rows = [hcpcs_row(), hcpcs_row("25", record="7"),
                hcpcs_row("AB", record="8"), hcpcs_row("12345"),
                hcpcs_row("D1234"), hcpcs_row("1234F")]
        result = importer.hcpcs_codes("\n".join(rows), START)
        self.assertEqual([row["code"] for row in result], ["A1234"])

    def test_release_dates_exclude_prior_termination_and_preserve_boundary_dates(self):
        rows = [
            hcpcs_row("A1234", terminated="20260930"),
            hcpcs_row("A1235", terminated="20261001"),
            hcpcs_row("A1236", terminated="20261130"),
            hcpcs_row("A1237", added="00000000", terminated="        "),
            hcpcs_row("A1238", added="20261101"),
        ]
        by_code = {row["code"]: row for row in importer.hcpcs_codes("\n".join(rows), START)}
        self.assertNotIn("A1234", by_code)
        self.assertEqual(by_code["A1235"]["effective_start"], START)
        self.assertEqual(by_code["A1235"]["effective_end"], START)
        self.assertEqual(by_code["A1236"]["effective_end"], "2026-11-30")
        self.assertIsNone(by_code["A1237"]["effective_end"])
        self.assertIsNone(by_code["A1237"]["metadata"]["added_on"])
        self.assertEqual(by_code["A1237"]["effective_start"], START)
        self.assertEqual(by_code["A1238"]["effective_start"], "2026-11-01")
        self.assertTrue(all(row["active"] for row in by_code.values()))

    def test_malformed_duplicate_and_orphan_procedure_records_are_rejected(self):
        for text in (
            hcpcs_row()[:292], hcpcs_row(record="4"), hcpcs_row(record="5"),
            hcpcs_row(added="20261301"), hcpcs_row(terminated="20260230"),
            "\n".join([hcpcs_row(), hcpcs_row()]),
        ):
            with self.subTest(row=text[:16]), self.assertRaises(ValueError):
                importer.hcpcs_codes(text, START)

    def test_missing_primary_description_is_rejected_before_producing_an_invalid_import(self):
        with self.assertRaisesRegex(ValueError, "description"):
            importer.hcpcs_codes(hcpcs_row(description=""), START)

    def test_cms_date_blank_zero_and_calendar_validation(self):
        self.assertIsNone(importer.cms_date("        "))
        self.assertIsNone(importer.cms_date("00000000"))
        self.assertEqual(importer.cms_date("20240229"), "2024-02-29")
        for invalid in ("2026-10-01", "20260229", "20260001", "20261000", "abcdefgh"):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                importer.cms_date(invalid)


class PcsOrderTests(unittest.TestCase):
    def test_pcs_seven_character_codes_have_no_dot_and_headings_are_not_billable(self):
        rows = "\r\n".join([
            icd_row("001", flag="0", order=1,
                    short="Central Nervous System, Bypass",
                    display="Central Nervous System, Bypass"),
            icd_row("0016070", flag="1", order=2,
                    short="Bypass Cereb Vent to Nasophar",
                    display="Bypass Cerebral Ventricle to Nasopharynx"),
            icd_row("02HA04Z", flag="1", order=3,
                    short="Reinsertion of valve", display="Reinsertion of valve"),
        ])
        prepared = importer.prepare("icd10pcs-2027", archive(PCS_MEMBER, rows))
        codes = prepared["codes"]
        self.assertEqual([row["code"] for row in codes], ["001", "0016070", "02HA04Z"])
        self.assertEqual([row["billable"] for row in codes], [False, True, True])
        self.assertEqual(prepared["system"], "ICD-10-PCS")
        self.assertEqual(prepared["edition"], "FY2027")
        self.assertEqual(prepared["effective_start"], START)
        self.assertEqual(prepared["effective_end"], "2027-09-30")

    def test_pcs_rows_reject_letter_i_or_o_and_bad_flags(self):
        for row in (
            icd_row("00I0000"), icd_row("00O0000"), icd_row("0016070", flag="2"),
            icd_row("001607"), icd_row("0016070", display=""),
        ):
            with self.subTest(row=row[:16]), self.assertRaises(ValueError):
                importer.prepare("icd10pcs-2027", archive(PCS_MEMBER, row))

    def test_canonical_rules_accept_emitted_pcs_and_hcpcs_shapes(self):
        # Mirrors canonical_code in src/terminology.rs for ICD-10-PCS and HCPCS.
        def canonical(system, code):
            compact = code.replace(".", "")
            if len(compact) != len(code):
                return False
            if system == "ICD-10-PCS":
                return (len(compact) == 7
                        and all(c.isalnum() and c not in "IO" for c in compact))
            if system == "HCPCS":
                return len(compact) == 5 and compact[0].isalpha() and compact[1:].isdigit()
            raise AssertionError(system)

        pcs = [row["code"] for row in importer.icd_codes(
            "\n".join([icd_row("0016070"), icd_row("02HA04Z")]), "ICD-10-PCS")]
        self.assertTrue(all(canonical("ICD-10-PCS", code) or code == "001" for code in pcs))
        self.assertTrue(canonical("ICD-10-PCS", "0016070"))
        self.assertTrue(canonical("ICD-10-PCS", "02HA04Z"))
        hcpcs = [row["code"] for row in importer.hcpcs_codes(hcpcs_row("B1234"), START)]
        self.assertEqual([code for code in hcpcs if canonical("HCPCS", code)], ["B1234"])


class MemberSelectionTests(unittest.TestCase):
    def test_each_dataset_targets_its_own_year_and_month_member(self):
        cases = {
            "icd10cm-2026": "icd10cm-order-2026.txt",
            "icd10cm-2027": "deep/icd10cm-order-2027.txt",
            "icd10pcs-2027": "icd10pcs_order_2027.txt",
            "hcpcs-2026-01": "HCPC2026_JAN_ANWEB_01122026.txt",
            "hcpcs-2026-04": "HCPC2026_APR_ANWEB.txt",
            "hcpcs-2026-07": "HCPC2026_JUL_ANWEB_06172026.txt",
            "hcpcs-2026-10": "HCPC2026_OCT_ANWEB_09232026.txt",
            "hcpcs-2027-01": "HCPC2027_JAN_ANWEB.txt",
        }
        for dataset, member in cases.items():
            with self.subTest(dataset=dataset):
                self.assertRegex(member, importer.member_pattern(dataset))

    def test_patterns_reject_other_editions_and_sidecar_members(self):
        for dataset, member in (
            ("icd10cm-2026", "icd10cm-order-2027.txt"),
            ("icd10cm-2027", "icd10cm-order-addenda-2027.txt"),
            ("icd10pcs-2027", "order_addenda_2027.txt"),
            ("hcpcs-2026-10", "HCPC2026_OCT_ANWEB_Transaction Report.txt"),
            ("hcpcs-2027-01", "HCPC2026_JAN_ANWEB.txt"),
            ("hcpcs-2027-01", "HCPC2027_recordlayout.txt"),
        ):
            with self.subTest(dataset=dataset, member=member):
                self.assertNotRegex(member, importer.member_pattern(dataset))

    def test_prepare_uses_the_year_matching_member(self):
        raw = archive(ICD26_MEMBER, icd_row("QA00101"))
        prepared = importer.prepare("icd10cm-2026", raw)
        self.assertEqual(prepared["edition"], "FY2026")
        self.assertEqual(prepared["effective_start"], "2025-10-01")
        self.assertEqual(prepared["effective_end"], "2026-09-30")
        with self.assertRaises(ValueError):
            importer.prepare("icd10cm-2026", archive(ICD_MEMBER, icd_row("QA00101")))

    def test_source_filenames_match_the_official_archive_names(self):
        self.assertEqual(importer.source_filename("icd10cm-2026"), "icd10cm-2026.zip")
        self.assertEqual(importer.source_filename("icd10pcs-2027"), "icd10pcs-2027.zip")
        self.assertEqual(importer.source_filename("hcpcs-2027-01"), "hcpcs-january-2027.zip")
        self.assertEqual(importer.source_filename("hcpcs-2026-04"), "hcpcs-april-2026.zip")

    def test_hcpcs_january_2027_edition_is_open_ended(self):
        spec = importer.DATASETS["hcpcs-2027-01"]
        self.assertEqual(spec["effective_start"], "2027-01-01")
        self.assertIsNone(spec["effective_end"])
        raw = archive(HCPCS_JAN27_MEMBER, hcpcs_row())
        prepared = importer.prepare("hcpcs-2027-01", raw)
        self.assertEqual(prepared["edition"], "2027-01")
        self.assertIsNone(prepared["effective_end"])


class ShippedCatalogTests(unittest.TestCase):
    def test_all_mode_writes_deterministic_catalogs_and_a_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources, output = root / "sources", root / "catalogs"
            sources.mkdir()
            for dataset in importer.DATASETS:
                if dataset.startswith("icd10cm"):
                    text = icd_row("QA00101")
                elif dataset.startswith("icd10pcs"):
                    text = icd_row("0016070")
                else:
                    text = hcpcs_row()
                (sources / importer.source_filename(dataset)).write_bytes(
                    archive(importer.member_pattern(dataset).replace("\\", "")
                            .replace("$", "").replace("^", "").replace("(_[0-9]+)?", "_001"),
                            text))
            first = io.StringIO()
            with contextlib.redirect_stdout(first):
                importer.prepare_all(sources, output)
            digest_a = {p.name: p.read_bytes()
                        for p in sorted(output.iterdir()) if p.name.endswith(".json.gz")}
            with contextlib.redirect_stdout(io.StringIO()):
                importer.prepare_all(sources, output)
            digest_b = {p.name: p.read_bytes()
                        for p in sorted(output.iterdir()) if p.name.endswith(".json.gz")}

            self.assertEqual(len(digest_a), len(importer.DATASETS))
            self.assertEqual(digest_a, digest_b)
            self.assertIn("icd-10-cm-FY2026.json.gz", digest_a)
            self.assertIn("icd-10-pcs-FY2027.json.gz", digest_a)
            self.assertIn("hcpcs-2027-01.json.gz", digest_a)

            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(len(manifest["datasets"]), len(importer.DATASETS))
            by_file = {entry["file"]: entry for entry in manifest["datasets"]}
            entry = by_file["icd-10-cm-FY2026.json.gz"]
            self.assertEqual(entry["system"], "ICD-10-CM")
            self.assertEqual(entry["edition"], "FY2026")
            self.assertEqual(entry["effective_start"], "2025-10-01")
            self.assertEqual(entry["effective_end"], "2026-09-30")
            self.assertEqual(entry["code_count"], 1)
            self.assertEqual(entry["source_sha256"],
                             hashlib.sha256((sources / "icd10cm-2026.zip").read_bytes()).hexdigest())
            self.assertEqual(entry["sha256"], hashlib.sha256(digest_a[entry["file"]]).hexdigest())
            self.assertIsNone(by_file["hcpcs-2027-01.json.gz"]["effective_end"])

            payload = json.loads(gzip.decompress(digest_a["icd-10-pcs-FY2027.json.gz"]))
            self.assertEqual(payload["codes"][0]["code"], "0016070")
            self.assertEqual(payload["request_id"], importer.request_id("icd10pcs-2027"))
            self.assertEqual(payload["request_id"], json.loads(gzip.decompress(
                digest_b["icd-10-pcs-FY2027.json.gz"]))["request_id"])
            self.assertEqual(gzip.decompress(digest_a["hcpcs-2027-01.json.gz"])
                             == gzip.decompress(digest_b["hcpcs-2027-01.json.gz"]), True)

    def test_gzip_streams_carry_no_timestamp(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            source = output / "src.zip"
            source.write_bytes(archive(ICD_MEMBER, icd_row("QA00101")))
            importer.write_catalog("icd10cm-2027", source.read_bytes(), output)
            stream = (output / "icd-10-cm-FY2027.json.gz").open("rb")
            with stream:
                header = stream.read(10)
            self.assertEqual(header[4:8], b"\x00\x00\x00\x00")

    def test_request_id_is_stable_and_unique_per_edition(self):
        seen = {importer.request_id(key) for key in importer.DATASETS}
        self.assertEqual(len(seen), len(importer.DATASETS))
        self.assertEqual(importer.request_id("icd10cm-2027"), importer.request_id("icd10cm-2027"))


class ArchiveAndCliTests(unittest.TestCase):
    def test_missing_ambiguous_and_oversized_source_members_are_rejected(self):
        with self.assertRaises(ValueError):
            importer.prepare("icd10cm-2027", archive("wrong.txt", icd_row("QA00101")))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as value:
            value.writestr("first/icd10cm-order-2027.txt", icd_row("QA00101"))
            value.writestr("second/icd10cm-order-2027.txt", icd_row("QA00101"))
        with self.assertRaises(ValueError):
            importer.prepare("icd10cm-2027", output.getvalue())
        raw = archive(ICD_MEMBER, icd_row("QA00101"))
        with patch.object(importer, "MAX_MEMBER", 10), self.assertRaises(ValueError):
            importer.prepare("icd10cm-2027", raw)
        with patch.object(importer, "MAX_ARCHIVE", 10), self.assertRaises(ValueError):
            importer.prepare("icd10cm-2027", raw)

    def test_local_archive_cli_writes_a_public_use_import_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "synthetic.zip", root / "prepared.json"
            source.write_bytes(archive(ICD_MEMBER, icd_row("QA00101")))
            arguments = ["prepare_terminology.py", "icd10cm-2027", "--archive", str(source), "--output", str(output)]
            with patch("sys.argv", arguments), patch.object(importer, "urlopen", side_effect=AssertionError("Network must not be used")), contextlib.redirect_stdout(io.StringIO()):
                importer.main()
            prepared = json.loads(output.read_text())
            self.assertEqual(prepared["codes"][0]["code"], "QA0.0101")
            self.assertEqual(prepared["rights"], "public_use")
            self.assertTrue(prepared["rights_attested"])
            self.assertEqual(prepared["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())


class DiscoverTests(unittest.TestCase):
    """Discovery with a fake fetch only: no network is contacted.

    Discovery publishes into the module-level DATASETS, so every case runs
    against a dataset map restored afterwards.
    """

    def setUp(self):
        patcher = mock.patch.dict(importer.DATASETS, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        importer.DATASETS.update(self.base_datasets())

    def base_datasets(self):
        return {
            "icd10cm-2027": {
                "system": "ICD-10-CM", "edition": "FY2027",
                "source_name": "CDC / NCHS ICD-10-CM FY2027 order file",
                "source_url": "https://example.invalid/icd10cm-2027.zip",
                "effective_start": "2026-10-01", "effective_end": "2027-09-30",
            },
            "icd10pcs-2027": {
                "system": "ICD-10-PCS", "edition": "FY2027",
                "source_name": "CMS ICD-10-PCS FY2027 order file",
                "source_url": "https://example.invalid/icd10pcs-2027.zip",
                "effective_start": "2026-10-01", "effective_end": "2027-09-30",
            },
            "hcpcs-2026-10": {
                "system": "HCPCS", "edition": "2026-10",
                "source_name": "CMS October 2026 HCPCS Level II public-use file",
                "source_url": "https://example.invalid/hcpcs-october-2026.zip",
                "effective_start": "2026-10-01", "effective_end": "2026-12-31",
            },
            "hcpcs-2027-01": {
                "system": "HCPCS", "edition": "2027-01",
                "source_name": "CMS January 2027 HCPCS Level II public-use file",
                "source_url": "https://example.invalid/hcpcs-january-2027.zip",
                "effective_start": "2027-01-01", "effective_end": None,
            },
        }

    def fixture_archive(self, dataset):
        if dataset.startswith("icd10cm"):
            text = icd_row("QA00101")
        elif dataset.startswith("icd10pcs"):
            text = icd_row("0016070")
        else:
            text = hcpcs_row()
        member = (importer.member_pattern(dataset).replace("\\", "")
                  .replace("$", "").replace("^", "").replace("(_[0-9]+)?", "_001"))
        return archive(member, text)

    def test_next_hcpcs_quarter_urls_include_year_rollover(self):
        cases = {
            "2026-01": ("hcpcs-2026-04", "april-2026", "2026-04-01"),
            "2026-04": ("hcpcs-2026-07", "july-2026", "2026-07-01"),
            "2026-07": ("hcpcs-2026-10", "october-2026", "2026-10-01"),
            "2026-10": ("hcpcs-2027-01", "january-2027", "2027-01-01"),
        }
        for edition, (code, slug, start) in cases.items():
            with self.subTest(edition=edition):
                found_code, url, spec = importer.next_hcpcs_candidate(edition)
                self.assertEqual(found_code, code)
                self.assertEqual(
                    url, f"https://www.cms.gov/files/zip/{slug}-alpha-numeric-hcpcs-file.zip")
                self.assertEqual(spec["effective_start"], start)
                self.assertIsNone(spec["effective_end"])

    def test_next_fiscal_year_urls_include_year_rollover(self):
        code, url, spec = importer.next_icd10cm_candidate("FY2027")
        self.assertEqual(code, "icd10cm-2028")
        self.assertEqual(
            url, "https://ftp.cdc.gov/pub/health_statistics/nchs/publications/"
                 "ICD10CM/2028/icd10cm-code-descriptions-2028.zip")
        self.assertEqual(spec["effective_start"], "2027-10-01")
        self.assertEqual(spec["effective_end"], "2028-09-30")
        code, url, spec = importer.next_icd10pcs_candidate("FY2026")
        self.assertEqual(code, "icd10pcs-2027")
        self.assertEqual(
            url, "https://www.cms.gov/files/zip/2027-"
                 "icd-10-pcs-order-file-long-abbreviated-titles.zip")
        self.assertEqual(spec["edition"], "FY2027")

    def write_fixture(self, root):
        datasets_path, directory = root / "datasets.json", root / "catalogs"
        directory.mkdir()
        datasets = self.base_datasets()
        datasets_path.write_text(json.dumps({"datasets": datasets}, indent=2) + "\n")
        live = dict(importer.DATASETS)
        for dataset, spec in datasets.items():
            live[dataset] = spec
            importer.write_catalog(dataset, self.fixture_archive(dataset), directory)
        return datasets_path, directory

    def test_nothing_found_writes_nothing_and_reports_no_codes(self):
        def fetch(method, url):
            raise importer.HTTPError(url, 404, "Not Found", {}, None)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            datasets_path, directory = self.write_fixture(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            datasets = json.loads(datasets_path.read_text())["datasets"]
            self.assertEqual(importer.discover(datasets, directory, fetch, datasets_path), [])
            self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()},
                             before)
            self.assertEqual(datasets_path.read_text(),
                             json.dumps({"datasets": self.base_datasets()}, indent=2) + "\n")

    def test_one_found_installs_catalog_datasets_entry_and_manifest(self):
        available = ("https://www.cms.gov/files/zip/april-2027-"
                     "alpha-numeric-hcpcs-file.zip")

        def fetch(method, url):
            if url == available:
                return self.fixture_archive("hcpcs-2027-04")
            raise importer.HTTPError(url, 404, "Not Found", {}, None)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            datasets_path, directory = self.write_fixture(root)
            datasets = json.loads(datasets_path.read_text())["datasets"]
            shipped_before = (directory / "hcpcs-2027-01.json.gz").read_bytes()
            found = importer.discover(datasets, directory, fetch, datasets_path)
            self.assertEqual(found, ["hcpcs-2027-04"])
            self.assertEqual(importer.DATASETS["hcpcs-2027-04"], datasets["hcpcs-2027-04"])
            catalog = json.loads(gzip.decompress(
                (directory / "hcpcs-2027-04.json.gz").read_bytes()))
            self.assertEqual(catalog["edition"], "2027-04")
            self.assertEqual(catalog["effective_start"], "2027-04-01")
            self.assertIsNone(catalog["effective_end"])
            # The previous edition keeps its bytes, its open end and its
            # datasets.json entry exactly as they were.
            self.assertEqual((directory / "hcpcs-2027-01.json.gz").read_bytes(),
                             shipped_before)
            stored = json.loads(datasets_path.read_text())["datasets"]
            self.assertEqual(list(stored), [*self.base_datasets(), "hcpcs-2027-04"])
            self.assertIsNone(stored["hcpcs-2027-01"]["effective_end"])
            self.assertEqual(stored["hcpcs-2026-10"]["effective_end"], "2026-12-31")
            manifest = json.loads((directory / "manifest.json").read_text())
            self.assertEqual({entry["file"] for entry in manifest["datasets"]},
                             {path.name for path in directory.glob("*.json.gz")})
            self.assertIn("hcpcs-2027-04.json.gz",
                          {entry["file"] for entry in manifest["datasets"]})

    def test_datasets_json_round_trips_through_the_loader(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "datasets.json"
            datasets = self.base_datasets()
            path.write_text(json.dumps({"datasets": datasets}, indent=2) + "\n")
            self.assertEqual(importer.load_datasets(path), datasets)
            with mock.patch.object(importer, "DATASETS",
                                   importer.load_datasets()) as live:
                shipped = importer.load_datasets()
                self.assertEqual(shipped, live)
            for code, spec in shipped.items():
                self.assertEqual(set(spec), {"system", "edition", "source_name",
                                             "source_url", "effective_start",
                                             "effective_end"})
                self.assertRegex(spec["source_url"], r"^https://")

    def test_readme_documents_the_open_ended_hcpcs_rule(self):
        readme = (Path(__file__).resolve().parent.parent
                  / "catalogs" / "README.md").read_text()
        self.assertIn("datasets.json", readme)
        self.assertIn("open `effective_end`", readme)
        self.assertIn("immutable", readme)

    def test_head_only_servers_and_transport_errors_fall_back_to_get(self):
        seen = []

        def head_unsupported(method, url):
            seen.append((method, url))
            if method == "HEAD":
                raise OSError("HEAD not supported")
            return b"payload"
        self.assertTrue(importer.url_exists("https://example.invalid/x.zip",
                                            head_unsupported))
        self.assertEqual([call[0] for call in seen], ["HEAD", "GET"])

        def always_down(method, url):
            raise importer.URLError("network down")
        self.assertFalse(importer.url_exists("https://example.invalid/x.zip",
                                             always_down))

        def not_found(method, url):
            raise importer.HTTPError(url, 404, "Not Found", {}, None)
        self.assertFalse(importer.url_exists("https://example.invalid/x.zip", not_found))

    def test_discover_cli_reports_one_line_and_exit_zero_when_nothing_exists(self):
        def fetch(method, url):
            raise importer.HTTPError(url, 404, "Not Found", {}, None)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            datasets_path, _directory = self.write_fixture(root)
            patcher = mock.patch.dict(importer.DATASETS, self.base_datasets(), clear=True)
            patcher.start()
            self.addCleanup(patcher.stop)
            with patch.object(importer, "DATASETS_FILE", datasets_path), \
                    patch.object(importer, "fetch_url", fetch), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(importer.discover_cli(root / "catalogs"), 0)
            self.assertEqual(out.getvalue().strip(),
                             "No new public code list editions found.")


if __name__ == "__main__":
    unittest.main()
