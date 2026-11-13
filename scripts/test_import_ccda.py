# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic C-CDA fixtures only; nothing here was copied from a real record."""
import base64
import contextlib
import hashlib
import http.server
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # also runnable as scripts.test_import_ccda
import import_ccda  # noqa: E402
from import_ccda import ImportProblem, collect, identity_hashes  # noqa: E402

SNOMED, RXNORM, ICD10, LOINC, CVX = ("2.16.840.1.113883.6.96", "2.16.840.1.113883.6.88", "2.16.840.1.113883.6.90",
                                     "2.16.840.1.113883.6.1", "2.16.840.1.113883.12.292")
SOURCE_ROOT = "2.16.999.1"
AUTHOR = ("<author><time value='20240105'/><assignedAuthor><id root='2.16.999.9' extension='77'/>"
          "<assignedPerson><name><given>Synthetic</given><family>Clinician</family></name></assignedPerson>"
          "<representedOrganization><name>Synthetic Clinic</name></representedOrganization></assignedAuthor></author>")


def section(code, title, text, entries=""):
    return (f"<component><section><code code='{code}' codeSystem='{LOINC}'/><title>{title}</title>"
            f"<text>{text}</text>{entries}</section></component>")


def empty(code, title, header):
    return section(code, title, f"<table><thead><tr><th>{header}</th></tr></thead><tbody><tr><td>No Information Available</td></tr></tbody></table>")


def document(patient_id="1001", given="Avery", family="Synthetic", birth="19900101", doc_id="D1", effective="20240110",
             problem_title="Synthetic spasticity", extra_ids="", sections=None, long_note=None):
    note = long_note or "Synthetic progress note line one.<br/>Line two."
    default = [
        section("11450-4", "PROBLEMS",
                "<table><thead><tr><th>Problem</th><th>Effective Dates</th><th>Problem Status</th><th>Problem Type</th><th>Problem Comments</th></tr></thead>"
                f"<tbody><tr ID='prob1'><td>{problem_title}</td><td>2020</td><td>Active</td><td>Diagnosis</td><td>Synthetic comment</td></tr></tbody></table>",
                f"<entry><act classCode='ACT' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='pr-1'/><statusCode code='active'/>"
                f"<entryRelationship typeCode='SUBJ'><observation classCode='OBS' moodCode='EVN' negationInd='false'>{AUTHOR}"
                f"<code code='55607006' codeSystem='{SNOMED}' displayName='Problem'/><text><reference value='#prob1'/></text>"
                "<effectiveTime><low value='20200304'/><high nullFlavor='UNK'/></effectiveTime>"
                f"<value code='G80.1' codeSystem='{ICD10}' codeSystemName='ICD10' displayName='{problem_title}'>"
                f"<translation code='1234567' codeSystem='{SNOMED}' codeSystemName='SNOMED-CT' displayName='Synthetic finding'/></value>"
                "</observation></entryRelationship></act></entry>"),
        section("10160-0", "MEDICATIONS",
                "<table><thead><tr><th>Medication</th><th>Status</th><th>Start Date</th><th>Instructions</th><th>Reason</th></tr></thead>"
                "<tbody><tr ID='med1'><td>Synthetic relaxant 10 mg tablet</td><td>Active</td><td>2023-02-01</td><td>One tablet at night</td><td></td></tr></tbody></table>",
                f"<entry><substanceAdministration classCode='SBADM' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='rx-1'/><text><reference value='#med1'/></text>"
                "<statusCode code='active'/><effectiveTime><low value='20230201'/><high nullFlavor='UNK'/></effectiveTime><doseQuantity nullFlavor='UNK'/>"
                f"<consumable><manufacturedProduct><manufacturedMaterial><code code='99999' codeSystem='{RXNORM}' codeSystemName='RxNorm' displayName='Synthetic relaxant 10 MG'>"
                "<translation code='00000-0000-00' codeSystem='2.16.840.1.113883.6.69' codeSystemName='NDC'/></code><name>Synthetic relaxant 10 mg tablet</name>"
                "</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>"),
        section("48765-2", "ALLERGIES",
                "<table><thead><tr><th>Substance</th><th>Reaction</th></tr></thead><tbody><tr><td>No Known Drug Allergies</td><td></td></tr></tbody></table>",
                "<entry><act classCode='ACT' moodCode='EVN'><id nullFlavor='NI'/><statusCode code='active'/><entryRelationship typeCode='SUBJ'>"
                "<observation classCode='OBS' moodCode='EVN' negationInd='true'><code code='ASSERTION' codeSystem='2.16.840.1.113883.5.4'/>"
                f"<value code='419511003' codeSystem='{SNOMED}' displayName='Propensity to adverse reactions to drug'/>"
                "<participant typeCode='CSM'><participantRole classCode='MANU'><playingEntity classCode='MMAT'><code nullFlavor='NA'/></playingEntity></participantRole></participant>"
                "</observation></entryRelationship></act></entry>"),
        section("46240-8", "ENCOUNTERS", "<table><thead><tr><th>Encounter</th></tr></thead><tbody><tr><td>Office visit</td></tr></tbody></table>",
                f"<entry><encounter classCode='ENC' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='enc-1'/>"
                "<code code='99213' codeSystem='2.16.840.1.113883.6.12' codeSystemName='CPT-4'><originalText>Office visit</originalText></code>"
                "<effectiveTime><low value='20240105093000-0500'/><high value='20240105100000-0500'/></effectiveTime>"
                "<performer><assignedEntity><assignedPerson><name><given>Synthetic</given><family>Clinician</family></name></assignedPerson></assignedEntity></performer>"
                "<entryRelationship typeCode='REFR'><act classCode='ACT' moodCode='EVN'><entryRelationship typeCode='SUBJ'><observation classCode='OBS' moodCode='EVN'>"
                f"<value code='G80.1' codeSystem='{ICD10}' codeSystemName='ICD10' displayName='Synthetic spasticity'/></observation></entryRelationship></act></entryRelationship>"
                "</encounter></entry>"),
        section("34109-9", "CLINICAL NOTES", f"<table><thead><tr><th>CLINICAL NOTES</th></tr></thead><tbody><tr><td ID='note1'><paragraph>{note}</paragraph></td></tr></tbody></table>",
                f"<entry><act classCode='ACT' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='note-1'/>"
                f"<code code='34109-9' codeSystem='{LOINC}'><translation code='11506-3' codeSystem='{LOINC}' displayName='Progress Note'/></code>"
                "<text mediaType='text/plain'><reference value='#note1'/></text><statusCode code='COMPLETE'/><effectiveTime value='20240105'/>"
                f"<entryRelationship typeCode='COMP' inversionInd='true'><encounter><id root='{SOURCE_ROOT}' extension='enc-1'/></encounter></entryRelationship></act></entry>"),
        section("8716-3", "VITAL SIGNS", "<table><thead><tr><th>Height</th></tr></thead><tbody><tr><td><content ID='v1'>170 cm</content></td></tr></tbody></table>",
                f"<entry><organizer classCode='CLUSTER' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='vs-1'/><effectiveTime value='20240105'/>"
                f"<component><observation classCode='OBS' moodCode='EVN'><code code='8302-2' codeSystem='{LOINC}' displayName='Body height'/><effectiveTime value='20240105'/>"
                "<value xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance' xsi:type='PQ' value='170' unit='cm'/></observation></component>"
                f"<component><observation classCode='OBS' moodCode='EVN'><code code='29463-7' codeSystem='{LOINC}' displayName='Body weight'/><value nullFlavor='UNK'/></observation></component>"
                "</organizer></entry>"),
        section("11369-6", "IMMUNIZATIONS", "<table><thead><tr><th>Vaccine Name</th></tr></thead><tbody><tr ID='imm1'><td>Synthetic vaccine</td></tr></tbody></table>",
                f"<entry><substanceAdministration classCode='SBADM' moodCode='EVN' negationInd='false'><id root='{SOURCE_ROOT}' extension='imm-1'/><statusCode code='completed'/>"
                "<effectiveTime value='20221001'/><consumable><manufacturedProduct><manufacturedMaterial>"
                f"<code code='140' codeSystem='{CVX}' codeSystemName='CVX' displayName='Synthetic influenza vaccine'/><lotNumberText>SYN-LOT</lotNumberText>"
                "</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>"),
        section("48768-6", "Insurance Providers",
                "<table><thead><tr><th>Insurance Company</th><th>Insurance Plan</th><th>Insurance Policy ID</th><th>Insurance Group Number</th></tr></thead>"
                "<tbody><tr><td>Synthetic Payer</td><td>Synthetic PPO</td><td>SYN-MEMBER-1</td><td>SYN-GROUP</td></tr></tbody></table>",
                "<entry><act classCode='ACT' moodCode='EVN'><id root='0d3f7a52-0000-4000-8000-000000000001'/><statusCode code='completed'/>"
                "<entryRelationship typeCode='COMP'><sequenceNumber value='1'/><act classCode='ACT' moodCode='EVN'><id root='2.16.999.2' extension='pol-1'/>"
                "<code code='5' codeSystem='2.16.840.1.113883.3.221.5' displayName='Private health insurance'/>"
                "<participant typeCode='COV'><time><low value='20230101'/></time><participantRole><id root='2.16.999.3' extension='SYN-MEMBER-1'/>"
                "<code code='SELF' codeSystem='2.16.840.1.113883.5.111' displayName='Self'/></participantRole></participant></act></entryRelationship></act></entry>"),
        section("30954-2", "RESULTS", "<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Synthetic panel</td></tr></tbody></table>",
                f"<entry><observation classCode='OBS' moodCode='EVN'><id root='{SOURCE_ROOT}' extension='res-1'/>"
                f"<code code='2345-7' codeSystem='{LOINC}' codeSystemName='LOINC' displayName='Synthetic glucose'/><statusCode code='completed'/><effectiveTime value='20231212'/></observation></entry>"),
        section("47519-4", "PROCEDURES", "<table><thead><tr><th>Procedure/Surgery/Device</th></tr></thead><tbody><tr><td ID='proc1'>Synthetic injection procedure</td></tr></tbody></table>",
                f"<entry><act classCode='ACT' moodCode='EVN'><code code='64615' codeSystem='2.16.840.1.113883.6.12' displayName='Synthetic chemodenervation'/>"
                "<text mediaType='text/plain'><reference value='#proc1'/></text><statusCode code='COMPLETE'/><effectiveTime><low value='20240105'/><high value='20240105'/></effectiveTime></act></entry>"),
        section("42349-1", "Reason For Referral", "Synthetic referral reason<br/>second line",
                f"<entry><act classCode='PCPR' moodCode='INT'><id root='{SOURCE_ROOT}' extension='ref-1'/><code code='3457005' codeSystem='{SNOMED}' displayName='Patient referral'/>"
                "<statusCode code='active'/><effectiveTime value='20240102'/><entryRelationship typeCode='RSON'><observation classCode='OBS' moodCode='EVN'>"
                f"<value code='G80.1' codeSystem='{ICD10}' displayName='Synthetic spasticity'/></observation></entryRelationship></act></entry>"),
        section("10164-2", "History of Present Illness", "<table><thead><tr><th>History of Present Illness</th></tr></thead><tbody><tr><td>Synthetic history narrative.</td></tr></tbody></table>"),
        section("29762-2", "SOCIAL HISTORY", "<table><thead><tr><th>Social History</th><th>Description</th></tr></thead><tbody><tr><td>Tobacco</td><td>Never smoker</td></tr></tbody></table>",
                f"<entry><observation classCode='OBS' moodCode='EVN'><code code='72166-2' codeSystem='{LOINC}'/><statusCode code='completed'/>"
                f"<value code='266919005' codeSystem='{SNOMED}' displayName='Never smoker'/></observation></entry>"),
        empty("47420-5", "FUNCTIONAL STATUS", "Functional Findings"),
        empty("75310-3", "Health Concerns", "Health Concerns"),
    ]
    body = "".join(default if sections is None else sections)
    birth_xml = f"<birthTime value='{birth}'/>" if birth else "<birthTime nullFlavor='UNK'/>"
    return (f"<?xml version='1.0' encoding='UTF-8'?><ClinicalDocument xmlns='urn:hl7-org:v3'><id root='2.16.999.19' extension='{doc_id}'/>"
            f"<title>Synthetic Clinic: Health Summary</title><effectiveTime value='{effective}'/>"
            f"<recordTarget><patientRole><id root='{SOURCE_ROOT}' extension='{patient_id}'/><id root='2.16.840.1.113883.4.1' extension='000-00-0000'/>{extra_ids}"
            "<addr><streetAddressLine>1 Synthetic Way</streetAddressLine><streetAddressLine>Suite 2</streetAddressLine><city>Testville</city><state>TX</state>"
            "<postalCode>75000</postalCode><country>USA</country></addr><telecom use='WP' value='tel:+1-555-0199'/><telecom use='MC' value='tel:+1-555-0100'/>"
            "<telecom value='mailto:synthetic.patient@example.test'/><telecom value='mailto:not an address'/>"
            f"<patient><name use='L'><given>{given}</given><given>Q</given><family>{family}</family></name><administrativeGenderCode code='F' displayName='Female'/>{birth_xml}"
            "<languageCommunication><languageCode code='es-US'/></languageCommunication></patient>"
            "</patientRole></recordTarget><custodian><assignedCustodian><representedCustodianOrganization><name>Synthetic Clinic</name>"
            f"</representedCustodianOrganization></assignedCustodian></custodian><component><structuredBody>{body}</structuredBody></component></ClinicalDocument>").encode()


PDF = b"%PDF-1.4\nsynthetic\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\nsynthetic"
JPEG = b"\xff\xd8\xff\xe0synthetic\xff\xd9"
HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00synthetic"
HTML = b"<html><head><link href='/shared-style.css'/><title>x</title></head><body><h3>Synthetic letter</h3><p>First <strong>line</strong><br>Second line</p><script>bad()</script></body></html>"


def archive(folder, name, members):
    with zipfile.ZipFile(pathlib.Path(folder) / name, "w") as z:
        for member, raw in members.items():
            z.writestr(member, raw)


class Export:
    """A synthetic export directory plus a private work directory."""

    def __enter__(self):
        self.temporary = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temporary.name)
        self.export, self.work = base / "export", base / "work"
        self.export.mkdir()
        self.work.mkdir(mode=0o700)
        return self

    def __exit__(self, *_):
        self.temporary.cleanup()

    def standard(self):
        archive(self.export, "a_one.zip", {"summary.xml": document(), "letter.pdf": PDF, "photo.heic": HEIC, "note.html": HTML,
                                           "insurance_card.jpg": JPEG, "copy_of_letter.pdf": PDF, "truncated.jpeg": JPEG[:-2], "scan.png": PNG})
        archive(self.export, "b_two.zip", {
            "old.xml": document("2002", "Blake", "Example", "19851231", doc_id="D2", effective="20230101", problem_title="Earlier wording"),
            "new.xml": document("2002", "Blake", "Example", "19851231", doc_id="D3", effective="20240201")})
        archive(self.export, "c_test.zip", {"summary.xml": document("3003", "Zztest", "Patient", "20000101", doc_id="D4")})
        archive(self.export, "d_nobirth.zip", {"summary.xml": document("4004", "Casey", "Sample-Name", "", doc_id="D5")})
        (self.export / "Errors_synthetic.txt").write_text("Total processed patients count: 4, failed count: 0\n")
        return self

    def collect(self, **options):
        return collect(self.export, "synthetic-emr", "export-1", salt="00" * 16, **options)


class PackageTest(unittest.TestCase):
    def test_package_matches_the_staged_import_contract(self):
        with Export() as fixture:
            packages, private, report = fixture.standard().collect()
            package = packages["package"]
            self.assertEqual(set(package["manifest"]), {"source_instance", "source_revision", "expected_counts", "consistency", "limitations"})
            self.assertEqual(package["manifest"]["consistency"], "read_only_export")
            self.assertEqual(package["manifest"]["expected_counts"], {
                "encounter": 2, "form": 8, "immunization": 2, "insurance": 2, "lab_result": 2, "medical_problem": 2, "medication": 2,
                "patient": 2, "procedure": 2, "referral": 2, "soap_note": 2, "vital": 2})
            self.assertTrue(set(package["manifest"]["expected_counts"]) <= set(import_ccda.KINDS))
            for item in package["items"]:
                self.assertEqual(list(item), ["kind", "source_id", "patient_source_id", "data", "source_data"])
                self.assertTrue(item["source_id"] == item["source_id"].strip() and 0 < len(item["source_id"]) <= 200)
                self.assertIsInstance(item["data"], dict)
                self.assertIsInstance(item["source_data"], dict)
                self.assertEqual(item["patient_source_id"] is None, item["kind"] == "patient")
            patient = package["items"][0]
            self.assertEqual(patient["data"], {"mrn": patient["data"]["mrn"], "given_name": "Avery Q", "family_name": "Synthetic", "birth_date": "1990-01-01"})
            self.assertRegex(patient["data"]["mrn"], r"^IM-[0-9A-F]{12}$")
            self.assertEqual(report["patients_parsed"], 3)
            self.assertEqual((report["patients_staged"], report["patients_excluded_as_test_records"], report["patients_failed"]), (2, 1, 1))
            self.assertEqual(report["quality"]["patients_missing_birth_date"], 1)
            self.assertEqual(report["other_top_level_files"], {".txt": 1})

    def test_source_codes_and_reconciliation_fields_are_preserved(self):
        with Export() as fixture:
            items = fixture.standard().collect()[0]["package"]["items"]
            by = lambda kind: next(i for i in items if i["kind"] == kind and i["patient_source_id"] == "1001")
            problem = by("medical_problem")
            self.assertEqual(problem["source_id"], f"1001/11450-4/{SOURCE_ROOT}:pr-1")
            self.assertEqual({(c["system"], c["code"]) for c in problem["source_data"]["codes"]}, {("ICD-10-CM", "G80.1"), ("SNOMED CT", "1234567")})
            # Keys read by src/clinical.rs map_source when a clinician reconciles the entry.
            self.assertEqual((problem["source_data"]["title"], problem["source_data"]["begdate"], problem["source_data"]["activity"]), ("Synthetic spasticity", "2020-03-04", "1"))
            self.assertIn("ICD-10-CM G80.1", problem["source_data"]["diagnosis"])
            self.assertEqual(problem["data"]["comments"], "Synthetic comment")
            self.assertEqual(problem["data"]["author"], "Synthetic Clinician")
            medication = by("medication")
            self.assertEqual({c["system"] for c in medication["source_data"]["codes"]}, {"RxNorm", "NDC"})
            self.assertEqual(medication["source_data"]["comments"], "Instructions: One tablet at night")
            self.assertEqual(by("immunization")["source_data"]["codes"][0]["system"], "CVX")
            self.assertEqual(by("immunization")["data"]["lot_number"], "SYN-LOT")
            self.assertEqual(by("vital")["data"]["body_height"], "170 cm")
            self.assertNotIn("body_weight", by("vital")["data"])
            self.assertEqual(by("encounter")["data"]["date"], "2024-01-05T09:30:00-05:00")
            self.assertIn("CPT 99213", by("encounter")["data"]["codes"])
            note = by("soap_note")
            self.assertEqual(note["data"]["note"], "Synthetic progress note line one.\nLine two.")
            self.assertEqual(note["source_data"]["source_encounter"], f"{SOURCE_ROOT}:enc-1")
            self.assertEqual(by("insurance")["data"]["policy_id"], "SYN-MEMBER-1")
            # What "Add as coverage" pre-fills, in the coverage form's own field names.
            self.assertEqual(by("insurance")["source_data"]["coverage"], {
                "payer_name": "Synthetic Payer", "member_id": "SYN-MEMBER-1", "group_number": "SYN-GROUP", "plan_name": "Synthetic PPO",
                "relationship": "self", "priority": "primary", "effective_date": "2023-01-01"})
            self.assertEqual(by("lab_result")["source_data"]["codes"][0]["code"], "2345-7")
            self.assertTrue(by("procedure")["source_id"].startswith("1001/47519-4/sha256:"))
            self.assertEqual(by("referral")["data"]["reasons"], "ICD-10-CM G80.1 (Synthetic spasticity)")

    def test_contact_details_are_structured_for_the_chart_and_kept_beside_the_history(self):
        with Export() as fixture:
            packages, _, report = fixture.standard().collect()
            items = packages["package"]["items"]
            contact = {"address": {"line1": "1 Synthetic Way", "line2": "Suite 2", "city": "Testville", "region": "TX", "postal_code": "75000", "country": "US"},
                       "phone": "+1-555-0100", "email": "synthetic.patient@example.test", "administrative_gender": "female", "language": "Spanish"}
            patient = next(i for i in items if i["kind"] == "patient" and i["source_id"] == "1001")
            self.assertEqual(patient["source_data"]["contact"], contact)
            self.assertEqual(set(patient["data"]), {"mrn", "given_name", "family_name", "birth_date"})
            # The same block rides on the read-only demographics record, for charts that already existed.
            form = next(i for i in items if i["source_id"] == "1001/demographics")
            self.assertEqual(form["source_data"]["contact"], contact)
            self.assertEqual(report["structured_fields"]["phone"], 2)
            self.assertEqual(report["structured_fields"]["coverage_member_id"], 2)

    def test_contact_values_the_chart_would_reject_are_left_out(self):
        role = import_ccda.parse_xml(
            b"<patientRole xmlns='urn:hl7-org:v3'><addr><city>Testville</city><country>Atlantis</country></addr>"
            b"<telecom value='tel:call the neighbour'/><telecom use='HP' value='tel:(555)%20555-0101'/><telecom value='mailto:a@b'/>"
            b"<patient><administrativeGenderCode code='X'/><languageCommunication><languageCode code='tlh'/></languageCommunication></patient></patientRole>")
        contact = import_ccda.structured_contact(role, role.find(import_ccda.HL7 + "patient"))
        self.assertEqual(contact, {"address": {"city": "Testville"}, "phone": "(555) 555-0101", "language": "tlh"})

    def test_sections_without_a_kind_become_attributed_narrative_and_placeholders_are_skipped(self):
        with Export() as fixture:
            packages, _, report = fixture.standard().collect()
            forms = [i for i in packages["package"]["items"] if i["kind"] == "form" and i["patient_source_id"] == "1001"]
            titles = sorted(i["data"]["title"] for i in forms)
            self.assertEqual(titles, ["Allergies: No known: Propensity to adverse reactions to drug", "Demographics (previous record system)",
                                      "History of Present Illness", "Social History"])
            history = next(i for i in forms if i["data"]["title"] == "History of Present Illness")
            self.assertEqual((history["data"]["text"], history["data"]["recorded_by"]), ("Synthetic history narrative.", "Synthetic Clinic"))
            social = next(i for i in forms if i["data"]["title"] == "Social History")
            self.assertEqual(social["source_data"]["codes"][0]["code"], "266919005")
            self.assertEqual(report["sections"]["Functional Status"], {"patients_with_entries": 0, "patients_with_placeholder_only": 2, "patients_without_section": 0, "import_kind": "form"})
            self.assertEqual(report["sections"]["Problems"]["patients_with_entries"], 2)
            self.assertEqual(report["sections"]["Allergies"]["import_kind"], "allergy")
            self.assertEqual(report["quality"]["negated_allergy_assertions_kept_as_narrative"], 3)
            self.assertNotIn("allergy", packages["package"]["manifest"]["expected_counts"])

    def test_rerun_is_identical_and_later_documents_supersede_earlier_ones(self):
        with Export() as fixture:
            first, _, report = fixture.standard().collect()
            second = fixture.collect()[0]
            self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
            problems = [i for i in first["package"]["items"] if i["kind"] == "medical_problem" and i["patient_source_id"] == "2002"]
            self.assertEqual([p["data"]["title"] for p in problems], ["Synthetic spasticity"])
            self.assertEqual(report["patients_with_several_documents"], 1)
            self.assertGreaterEqual(report["quality"]["entries_superseded_by_later_document"], 1)
            self.assertGreaterEqual(report["quality"]["entries_repeated_across_documents"], 5)

    def test_government_identifiers_never_enter_the_package_and_report_has_no_patient_data(self):
        with Export() as fixture:
            packages, private, report = fixture.standard().collect()
            self.assertNotIn("000-00-0000", json.dumps(packages))
            self.assertEqual(report["quality"]["government_identifiers_dropped"], 3)
            printed = json.dumps(report)
            for secret in ("Avery", "Synthetic spasticity", "1001", "2002", "a_one", "SYN-MEMBER-1", "1990", "Blake", "IM-"):
                self.assertNotIn(secret, printed)
            self.assertEqual([e["label"] for e in private["index"]], ["P01", "P02", "P03", "P04"])
            self.assertEqual([e["status"] for e in private["index"]], ["imported", "imported", "excluded_test_record", "failed"])

    def test_long_notes_are_split_so_every_record_fits_one_request(self):
        with Export() as fixture:
            archive(fixture.export, "a.zip", {"s.xml": document(long_note="<br/>".join(f"Synthetic line {n} " + "x" * 400 for n in range(260)))})
            packages, _, report = fixture.collect()
            parts = [i for i in packages["package"]["items"] if i["kind"] == "soap_note"]
            self.assertGreater(len(parts), 2)
            self.assertEqual(parts[1]["source_id"], parts[0]["source_id"] + "#part2")
            self.assertIn("(part 1 of", parts[0]["data"]["title"])
            self.assertEqual("\n".join(p["data"]["note"] for p in sorted(parts, key=lambda p: p["source_data"]["part"])).count("Synthetic line"), 260)
            for batch in import_ccda.batches(packages["package"]):
                self.assertLessEqual(len(batch), 50)
                self.assertLess(len(json.dumps({"items": batch}, ensure_ascii=False).encode()), 64 * 1024)

    def test_unpacked_copy_of_an_archive_is_not_counted_twice(self):
        with Export() as fixture:
            archive(fixture.export, "a_one.zip", {"s.xml": document()})
            (fixture.export / "a_one").mkdir()
            (fixture.export / "a_one" / "s.xml").write_bytes(document())
            (fixture.export / "e_folder").mkdir()
            (fixture.export / "e_folder" / "s.xml").write_bytes(document("5005", "Drew", "Folder", "19700707", doc_id="D9"))
            report = fixture.collect()[2]
            self.assertEqual((report["archives"], report["patients_staged"]), (2, 2))
            self.assertEqual(report["quality"]["unpacked_duplicate_archives_skipped"], 1)

    def test_malformed_and_hostile_documents_fail_only_their_archive(self):
        with Export() as fixture:
            archive(fixture.export, "a.zip", {"s.xml": document()})
            archive(fixture.export, "b.zip", {"s.xml": b"<!DOCTYPE x [<!ENTITY a 'b'>]><ClinicalDocument xmlns='urn:hl7-org:v3'/>"})
            archive(fixture.export, "c.zip", {"s.xml": b"<ClinicalDocument"})
            archive(fixture.export, "d.zip", {"one.xml": document("7001", doc_id="D7"), "two.xml": document("7002", doc_id="D8")})
            archive(fixture.export, "e.zip", {"s.xml": document("1001", doc_id="D6")})
            archive(fixture.export, "f.zip", {"s.xml": document("8001", sections=[
                section("11450-4", "PROBLEMS", "<table><tbody><tr><td>x</td></tr></tbody></table>", "<entry><act><entryRelationship><observation><effectiveTime><low value='2024-01-05'/></effectiveTime></observation></entryRelationship></act></entry>")])})
            _, private, report = fixture.collect()
            self.assertEqual([e["status"] for e in private["index"]], ["imported", "failed", "failed", "failed", "failed", "imported"])
            self.assertEqual(report["failure_reasons"], {"document type declarations are not accepted": 1, "document is not well-formed XML": 1,
                                                         "archive mixes documents of different patients": 1, "patient already appeared in another archive": 1})
            self.assertEqual(report["quality"]["unparseable_dates"], 1)

    def test_outputs_are_private_and_batches_follow_the_api_limits(self):
        with Export() as fixture:
            fixture.standard()
            arguments = ["package", "--export-dir", str(fixture.export), "--work-dir", str(fixture.work), "--source-instance", "synthetic-emr",
                         "--source-revision", "export-1", "--confirm-source-read-only"]
            with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                import_ccda.main(arguments)
                first = (fixture.work / "package.json").read_bytes()
                import_ccda.main(arguments)
            self.assertEqual(first, (fixture.work / "package.json").read_bytes())
            for path in fixture.work.rglob("*"):
                self.assertEqual(path.stat().st_mode & 0o077, 0, path.name)
            package = json.loads((fixture.work / "package.json").read_text())
            staged = [i for path in sorted((fixture.work / "batches").glob("batch-*.json")) for i in json.loads(path.read_text())["items"]]
            self.assertEqual(staged, package["items"])
            self.assertEqual(json.loads((fixture.work / "batches" / "manifest.json").read_text()), package["manifest"])
            sql = (fixture.work / "match-query.sql").read_text()
            self.assertIn("BEGIN TRANSACTION READ ONLY", sql)
            self.assertNotIn("Avery", sql)
            os.chmod(fixture.work, 0o755)
            with open(os.devnull, "w") as quiet, contextlib.redirect_stderr(quiet), self.assertRaises(SystemExit):
                import_ccda.main(arguments)
            with self.assertRaises(ImportProblem):
                import_ccda.private_directory(fixture.export / "inside", fixture.export)


FIXTURE = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ccda_import_synthetic.json"


class ImporterFixtureTest(unittest.TestCase):
    def test_package_staged_by_the_rust_importer_test_is_current(self):
        """tests/connect_migrate.rs stages this exact package; UPDATE_CCDA_FIXTURE=1 rewrites it."""
        with Export() as fixture:
            packages, private, _ = fixture.standard().collect()
            plan = next(p for p in private["attachments"] if p["member"] == "note.html")
            upload = import_ccda.prepare_upload(plan, HTML, fixture.work)
        text = json.dumps(dict(packages["package"], document_upload=upload), ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        if os.environ.get("UPDATE_CCDA_FIXTURE"):
            FIXTURE.write_text(text, encoding="utf-8")
        self.assertEqual(FIXTURE.read_text(encoding="utf-8"), text)


class IdentityTest(unittest.TestCase):
    def test_hashes_ignore_case_spacing_punctuation_and_middle_names(self):
        base = identity_hashes("salt", "O'Synthetic-Example", "Avery Q", "1990-01-01")
        self.assertEqual(base, identity_hashes("salt", "osynthetic example", "AVERY", "1990-01-01"))
        self.assertEqual(base["v1"], hashlib.sha256(b"salt|v1|osyntheticexample|avery|1990-01-01").hexdigest())
        other = identity_hashes("salt", "Osyntheticexample", "Alex", "1990-01-01")
        self.assertNotEqual(base["v1"], other["v1"])
        self.assertEqual(base["v2"], other["v2"])
        self.assertEqual(base["v3"], identity_hashes("salt", "Married", "Avery", "1990-01-01")["v3"])
        self.assertNotEqual(base, identity_hashes("pepper", "O'Synthetic-Example", "Avery Q", "1990-01-01"))

    def test_every_patient_is_staged_and_the_overlap_check_stays_read_only(self):
        """Matching to existing charts is decided on the Data import page, not held back here."""
        with Export() as fixture:
            fixture.standard()
            (fixture.work / "package-held-matches.json").write_text("{}")
            (fixture.work / "link-existing-patients.sql").write_text("-- stale")
            packages, private, report = fixture.collect()
            self.assertEqual(set(packages), {"package"})
            self.assertEqual({i["source_id"] for i in packages["package"]["items"] if i["kind"] == "patient"}, {"1001", "2002"})
            self.assertNotIn("patients_held_as_existing_matches", report)
            import_ccda.write_outputs(fixture.work, packages, private, report, "synthetic-emr")
            self.assertFalse((fixture.work / "package-held-matches.json").exists() or (fixture.work / "link-existing-patients.sql").exists())
            sql = (fixture.work / "match-query.sql").read_text()
            self.assertIn("BEGIN TRANSACTION READ ONLY", sql)
            self.assertIn(identity_hashes("00" * 16, "Example", "Blake", "1985-12-31")["v1"], sql)
            self.assertNotIn("INSERT", sql.upper())
            self.assertNotIn("source_identifiers", sql)

    def test_digest_matches_the_importer_serialization(self):
        item = {"kind": "patient", "source_id": "p\"1", "patient_source_id": None,
                "data": {"mrn": "IM-1", "given_name": "Zoë", "family_name": "Line\nBreak", "birth_date": "1990-01-01"}, "source_data": {"b": 1, "a": {"z": [True, None], "y": "\u0001"}}}
        self.assertEqual(import_ccda.canonical(item),
                         '{"kind":"patient","source_id":"p\\"1","patient_source_id":null,"data":{"birth_date":"1990-01-01","family_name":"Line\\nBreak","given_name":"Zoë","mrn":"IM-1"},'
                         '"source_data":{"a":{"y":"\\u0001","z":[true,null]},"b":1}}')


class Stub(http.server.BaseHTTPRequestHandler):
    uploads, links, requests = [], [], []

    def log_message(self, *_):
        pass

    def reply(self, value, code=200):
        raw = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer synthetic-token":
            return self.reply({}, 401)
        Stub.requests.append(self.path)
        self.reply({"items": Stub.links})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Stub.uploads.append((self.path, body))
        self.reply({"id": "99999999-0000-4000-8000-000000000000"})


class AttachmentTest(unittest.TestCase):
    def test_plan_reports_types_conversions_and_duplicates(self):
        with Export() as fixture:
            _, private, report = fixture.standard().collect()
            plans = {p["member"]: p for p in private["attachments"]}
            self.assertEqual({m: (p["upload_type"], p["conversion"]) for m, p in plans.items()}, {
                "letter.pdf": ("application/pdf", "none"), "photo.heic": ("image/jpeg", "heic_to_jpeg"), "note.html": ("text/plain", "html_to_text"),
                "insurance_card.jpg": ("image/jpeg", "none"), "truncated.jpeg": ("image/jpeg", "reencode_jpeg"), "scan.png": ("image/png", "none")})
            self.assertEqual(plans["insurance_card.jpg"]["category"], "insurance")
            self.assertEqual(report["quality"]["duplicate_attachments_within_patient"], 1)
            self.assertEqual((report["attachments"]["total_files"], report["attachments"]["mapped_to_one_patient"]), (6, 6))
            self.assertEqual(report["attachments"]["by_type"]["image/heic"]["heic_to_jpeg"], 1)
            self.assertEqual(import_ccda.plan_attachment("x.bin", b"MZ\x00")["conversion"], "unsupported")
            self.assertEqual(import_ccda.plan_attachment("x.pdf", b"%PDF-1.4 cut")["conversion"], "unsupported")

    def test_html_becomes_plain_text_without_markup_or_scripts(self):
        self.assertEqual(import_ccda.html_to_text(HTML), b"Synthetic letter\n\nFirst line\nSecond line\n")

    def test_upload_uses_the_patient_documents_contract_and_stable_request_ids(self):
        with Export() as fixture:
            fixture.standard()
            packages, private, report = fixture.collect()
            import_ccda.write_outputs(fixture.work, packages, private, report, "synthetic-emr")
            job = "bbbbbbbb-0000-4000-8000-000000000002"
            # The committed job says where each imported patient went, whether the chart was new or attached.
            Stub.uploads, Stub.requests = [], []
            Stub.links = [{"source_patient_id": "1001", "patient_id": "aaaaaaaa-0000-4000-8000-000000000001"}]
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                api = import_ccda.Api(f"http://127.0.0.1:{server.server_port}", "synthetic-token")
                ready = import_ccda.attach(fixture.export, fixture.work, None, dry_run=True)
                convert = lambda raw, suffix, work: JPEG
                original, import_ccda.to_jpeg = import_ccda.to_jpeg, convert
                try:
                    first = import_ccda.attach(fixture.export, fixture.work, api, job_id=job)
                    again = import_ccda.attach(fixture.export, fixture.work, api, job_id=job)
                finally:
                    import_ccda.to_jpeg = original
            finally:
                server.shutdown()
                server.server_close()
            self.assertEqual(first, {"uploaded": 6})
            self.assertEqual(first, again)
            self.assertEqual(Stub.requests, [f"/api/v1/migrations/{job}/patient-links"] * 2)
            Stub.links = []
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                import_ccda.main(["attach", "--export-dir", str(fixture.export), "--work-dir", str(fixture.work), "--api-base", "https://example.invalid"])
            self.assertIn("ready", "".join(ready))
            bodies = [body for _, body in Stub.uploads[:6]]
            self.assertEqual([body["request_id"] for _, body in Stub.uploads[6:]], [b["request_id"] for b in bodies])
            self.assertTrue(all(path == "/api/v1/patients/aaaaaaaa-0000-4000-8000-000000000001/documents" for path, _ in Stub.uploads))
            for body in bodies:
                self.assertEqual(set(body), {"request_id", "filename", "content_type", "content_base64", "content", "reason"})
                self.assertEqual(set(body["content"]), {"title", "category", "document_date", "visit_id", "notes", "status"})
                self.assertIn(body["content_type"], ("application/pdf", "image/png", "image/jpeg", "text/plain"))
            text = next(b for b in bodies if b["content_type"] == "text/plain")
            self.assertEqual((text["filename"], base64.b64decode(text["content_base64"])), ("note.txt", b"Synthetic letter\n\nFirst line\nSecond line\n"))
            self.assertIn("Converted for storage", text["content"]["notes"])
            with self.assertRaises(ImportProblem):
                import_ccda.Api("http://example.invalid", "t")
            with self.assertRaises(ImportProblem):
                import_ccda.Api("https://example.invalid", "")


if __name__ == "__main__":
    unittest.main()
