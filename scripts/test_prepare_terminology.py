#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic fixed-width fixtures; no downloaded catalogs or CPT descriptors."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "prepare_terminology", Path(__file__).with_name("prepare_terminology.py")
)
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)

ICD_MEMBER = "synthetic-release/icd10cm-order-2027.txt"
HCPCS_MEMBER = "HCPC2026_OCT_ANWEB_001.txt"
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


if __name__ == "__main__":
    unittest.main()
