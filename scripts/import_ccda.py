#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 P Industries
"""Turn a directory of per-patient HL7 C-CDA archives into a staged SunCharts import.

`package` reads every patient archive (a .zip, or an unpacked folder) without
extracting or changing it and writes, into a private 0700 work directory:

  package.json          {"manifest", "items"} for Data import / POST /api/v1/migrations
  batches/              manifest.json plus batch-NNNN.json bodies for .../items
  patient-index.json    P01.. labels to archives (contains patient data)
  match-hashes.json     salted SHA-256 identity hashes, and match-query.sql (optional pre-check)
  attachments.json      per-file upload plan (contains patient data)
  report.json           counts only; the same report is printed

`attach` uploads the planned files to already imported patients through
POST /api/v1/patients/{id}/documents, finding each patient's chart through the
committed import job. Nothing else in this tool uses the network.

`files` writes the same upload-ready files into a private 0700 folder, named by
their SHA-256, with a `files-manifest.json`. The practice owner picks that folder
on the Data import page ("Add files from the previous system"), which uploads each
file under the same request ID `attach` would use, so neither path duplicates the other.

Only the printed report is free of patient data. Everything else stays in the work
directory and must never be committed. This is not a complete EHI import: patients
become charts (name, birth date, MRN and contact details), and every other record
is preserved as attributed, read-only source history. Patients who look like an
existing chart are matched on the Data import page, where the owner attaches them
or creates a new chart.
"""
import argparse
import base64
import collections
import datetime
import hashlib
import html.parser
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import xml.parsers.expat
import zipfile

HL7 = "{urn:hl7-org:v3}"
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024  # src/documents.rs MAX_BYTES
MAX_TEXT_DOCUMENT_BYTES = 200_000  # src/documents.rs text/plain limit
MAX_ITEM_BYTES = 56_000  # one staged record must fit the 64 KiB API body
MAX_BATCH_BYTES = 60_000
MAX_BATCH_ITEMS = 50
MAX_JOB_ITEMS = 100_000
NOTE_PART_BYTES = 30_000
HISTORY_VIEW_LIMIT = 100  # /api/v1/patients/{id}/history returns at most 100 rows
UUID_NAMESPACE = uuid.UUID("6f0f3f2e-5d4b-5c5e-9f43-0c1b8a2d7e11")

# Kinds accepted by src/migration.rs that this tool produces.
KINDS = ("patient", "medical_problem", "allergy", "medication", "encounter", "soap_note", "vital",
         "immunization", "insurance", "lab_result", "procedure", "referral", "form")
# LOINC section code -> (report name, import kind). "form" is the generic preserved kind:
# the importer has no dedicated kind for these sections, so they stay attributed narrative.
SECTIONS = {
    "11450-4": ("Problems", "medical_problem"),
    "10160-0": ("Medications", "medication"),
    "48765-2": ("Allergies", "allergy"),
    "46240-8": ("Encounters", "encounter"),
    "34109-9": ("Clinical Notes", "soap_note"),
    "8716-3": ("Vital Signs", "vital"),
    "11369-6": ("Immunizations", "immunization"),
    "48768-6": ("Insurance Providers", "insurance"),
    "30954-2": ("Results", "lab_result"),
    "47519-4": ("Procedures", "procedure"),
    "42349-1": ("Reason for Referral", "referral"),
    "85847-2": ("Care Team", "form"),
    "69730-0": ("Instructions", "form"),
    "46264-8": ("Medical Devices", "form"),
    "10164-2": ("History of Present Illness", "form"),
    "29299-5": ("Reason for visit", "form"),
    "18776-5": ("Plan of Care", "form"),
    "75310-3": ("Health Concerns", "form"),
    "61146-7": ("Goals", "form"),
    "47420-5": ("Functional Status", "form"),
    "10154-3": ("Chief Complaint", "form"),
    "51848-0": ("Assessments", "form"),
    "29762-2": ("Social History", "form"),
    "10157-6": ("Family History", "form"),
    "11348-0": ("Past Medical History", "form"),
    "10190-7": ("Mental Status", "form"),
}
CODE_SYSTEMS = {
    "2.16.840.1.113883.6.96": "SNOMED CT",
    "2.16.840.1.113883.6.88": "RxNorm",
    "2.16.840.1.113883.6.90": "ICD-10-CM",
    "2.16.840.1.113883.6.3": "ICD-10",
    "2.16.840.1.113883.6.4": "ICD-10-PCS",
    "2.16.840.1.113883.6.103": "ICD-9-CM",
    "2.16.840.1.113883.6.1": "LOINC",
    "2.16.840.1.113883.12.292": "CVX",
    "2.16.840.1.113883.6.69": "NDC",
    "2.16.840.1.113883.6.12": "CPT",
    "2.16.840.1.113883.6.285": "HCPCS",
    "2.16.840.1.113883.6.101": "NUCC",
    "2.16.840.1.113883.3.221.5": "Source of Payment Typology",
    "2.16.840.1.113883.6.259": "HL7 Healthcare Service Location",
    "2.16.840.1.113883.5.1": "HL7 AdministrativeGender",
    "2.16.840.1.113883.5.4": "HL7 ActCode",
    "2.16.840.1.113883.5.6": "HL7 ActClass",
    "2.16.840.1.113883.5.7": "HL7 ActPriority",
    "2.16.840.1.113883.5.83": "HL7 ObservationInterpretation",
    "2.16.840.1.113883.5.110": "HL7 RoleClass",
    "2.16.840.1.113883.5.111": "HL7 RoleCode",
}
CODE_SYSTEM_NAMES = {
    "snomedct": "SNOMED CT", "snomed": "SNOMED CT", "rxnorm": "RxNorm", "icd10": "ICD-10-CM",
    "icd10cm": "ICD-10-CM", "icd9cm": "ICD-9-CM", "loinc": "LOINC", "cvx": "CVX", "ndc": "NDC",
    "cpt": "CPT", "cpt4": "CPT", "hcpcs": "HCPCS", "nucc": "NUCC",
    "httpnuccorgprovidertaxonomy": "NUCC",
}
# Government identifiers are never copied into the package.
SENSITIVE_ID_ROOTS = ("2.16.840.1.113883.4.1", "2.16.840.1.113883.4.2", "2.16.840.1.113883.4.3")
CREDENTIAL_KEYS = {"accountkey", "account_key", "apikey", "password", "password_hash", "client_secret",
                   "access_token", "refresh_token", "api_key", "private_key", "x12_sftp_login",
                   "x12_sftp_pass", "x12_client_id", "x12_client_secret", "x12_isa02", "x12_isa04"}
PLACEHOLDER = re.compile(
    r"^(no (known )?(information|data|records?|entries)( (is )?(available|recorded|on file))?"
    r"|none( recorded| known| reported)?|not (available|on file|recorded)|n/?a|unknown)\.?$", re.I)
TEST_NAME = re.compile(r"^(zz.*|test\d*|testing|testpatient|tester|demo|sample|fake|dummy|donotuse)$")
DOCUMENT_CATEGORIES = (
    ("insurance", r"insurance|coverage|eligib|payer|\bcard\b"), ("identity", r"licen[cs]e|passport|photo id|\bid\b"),
    ("consent", r"consent|hipaa|authori[sz]ation|acknowledg|\bpolicy\b|polic(y|ies)"),
    ("referral", r"referral|referring"), ("laboratory", r"\blabs?\b|laborator|patholog"),
    ("imaging", r"\bmri\b|\bct\b|x-?ray|imaging|radiolog|ultrasound|\bemg\b"),
    ("consult", r"consult|progress|visit|note|letter|report|summary"),
)


class ImportProblem(Exception):
    """Raised with a message that never contains patient data."""


def local(tag):
    return tag.rsplit("}", 1)[-1]


def clean(value):
    return " ".join((value or "").split())


def parse_xml(raw):
    """Parse untrusted XML: no DTD, no entity declarations, nothing fetched."""
    builder = ET.TreeBuilder()
    parser = xml.parsers.expat.ParserCreate(namespace_separator="}")

    def name(value):
        return "{" + value if "}" in value else value

    def forbid(*_):
        raise ImportProblem("document type declarations are not accepted")
    parser.StartDoctypeDeclHandler = forbid
    parser.EntityDeclHandler = forbid
    parser.buffer_text = True
    parser.StartElementHandler = lambda tag, attrs: builder.start(name(tag), {name(k): v for k, v in attrs.items()})
    parser.EndElementHandler = lambda tag: builder.end(name(tag))
    parser.CharacterDataHandler = builder.data
    try:
        parser.Parse(raw, True)
        return builder.close()
    except (xml.parsers.expat.ExpatError, AssertionError):
        raise ImportProblem("document is not well-formed XML") from None


def text_of(element):
    """Narrative text with line breaks kept; never includes markup."""
    if element is None:
        return ""
    parts = []

    def walk(node):
        tag = local(node.tag)
        if tag == "br":
            parts.append("\n")
        if node.text:
            parts.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                parts.append(child.tail)
        if tag in ("paragraph", "tr", "item", "caption", "list", "table"):
            parts.append("\n")
        elif tag in ("td", "th"):
            parts.append(" ")
    walk(element)
    lines = [clean(line) for line in "".join(parts).split("\n")]
    out = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def timestamp(element, stats=None):
    """HL7 TS (YYYYMMDD[HHMM[SS]][+ZZZZ]) to ISO 8601; None when absent."""
    value = element.get("value") if element is not None else None
    if not value:
        return None
    match = re.fullmatch(r"(\d{4})(\d{2})?(\d{2})?(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?([+-]\d{4})?", value)
    try:
        if not match:
            raise ValueError
        year, month, day, hour, minute, second, zone = match.groups()
        if not month:
            return year
        if not day:
            datetime.date(int(year), int(month), 1)
            return f"{year}-{month}"
        datetime.date(int(year), int(month), int(day))
        if hour is None:
            return f"{year}-{month}-{day}"
        datetime.time(int(hour), int(minute), int(second or 0))
        return f"{year}-{month}-{day}T{hour}:{minute}:{second or '00'}" + (f"{zone[:3]}:{zone[3:]}" if zone else "")
    except ValueError:
        if stats is not None:
            stats["quality"]["unparseable_dates"] += 1
        return None


def interval(element, stats):
    if element is None:
        return None, None
    if element.get("value"):
        return timestamp(element, stats), None
    return timestamp(element.find(HL7 + "low"), stats), timestamp(element.find(HL7 + "high"), stats)


def codings(element, stats=None):
    """Source codes of a coded element and its translations, systems named by OID."""
    out = []
    if element is None:
        return out
    for node in [element] + element.findall(HL7 + "translation"):
        code = node.get("code")
        if not code:
            continue
        oid, name = node.get("codeSystem") or "", node.get("codeSystemName") or ""
        by_name = CODE_SYSTEM_NAMES.get(re.sub(r"[^a-z0-9]", "", name.lower()))
        entry = {"system": CODE_SYSTEMS.get(oid) or by_name or name or oid, "code": code}
        for key, value in (("system_oid", oid), ("system_name", name), ("display", node.get("displayName"))):
            if value:
                entry[key] = value
        if oid in CODE_SYSTEMS and by_name and by_name != CODE_SYSTEMS[oid]:
            entry["system_conflict"] = True  # the source labels this OID as another system
            if stats is not None:
                stats["quality"]["code_system_label_conflicts"] += 1
        out.append(entry)
    return out


def code_text(codes):
    return "; ".join(f"{c['system']} {c['code']}" + (f" ({c['display']})" if c.get("display") else "") for c in codes)


def display(element, fallback=""):
    if element is None:
        return fallback
    for node in [element] + element.findall(HL7 + "translation"):
        if node.get("displayName"):
            return clean(node.get("displayName"))
    return clean(element.findtext(HL7 + "originalText")) or fallback


def person(name):
    if name is None:
        return ""
    given = " ".join(clean(g.text) for g in name.findall(HL7 + "given") if clean(g.text))
    return clean(f"{given} {clean(name.findtext(HL7 + 'family'))}") or clean("".join(name.itertext()))


def author_of(element):
    author = element.find(HL7 + "author") if element is not None else None
    if author is None:
        return {}
    out = {"author": person(author.find(f"{HL7}assignedAuthor/{HL7}assignedPerson/{HL7}name")),
           "authored": timestamp(author.find(HL7 + "time")),
           "author_organization": clean(author.findtext(f"{HL7}assignedAuthor/{HL7}representedOrganization/{HL7}name"))}
    return {k: v for k, v in out.items() if v}


def xml_json(element, stats=None):
    """Lossless structural copy of a source entry, minus government identifiers."""
    node = {"tag": local(element.tag)}
    if element.attrib:
        node["attrs"] = {local(k): v for k, v in sorted(element.attrib.items())}
    if clean(element.text):
        node["text"] = clean(element.text)
    children = []
    for child in element:
        if local(child.tag) == "id" and (child.get("root") or "").startswith(SENSITIVE_ID_ROOTS):
            if stats is not None:
                stats["quality"]["government_identifiers_dropped"] += 1
            continue
        children.append(xml_json(child, stats))
    if children:
        node["children"] = children
    return node


def contains_credentials(value):
    if isinstance(value, dict):
        return any(k.lower() in CREDENTIAL_KEYS or contains_credentials(v) for k, v in value.items())
    if isinstance(value, list):
        return any(contains_credentials(v) for v in value)
    return False


def canonical(item):
    """Byte-for-byte what serde_json::to_string(&Item) produces in src/migration.rs."""
    def dump(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return ('{"kind":' + dump(item["kind"]) + ',"source_id":' + dump(item["source_id"]) + ',"patient_source_id":'
            + dump(item["patient_source_id"]) + ',"data":' + dump(item["data"]) + ',"source_data":' + dump(item["source_data"]) + "}")


def item_digest(item):
    return hashlib.sha256(canonical(item).encode()).hexdigest()


def digest_of(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


# --- archives -------------------------------------------------------------------------------

class Archive:
    """Read-only view of one patient archive; nothing is extracted to disk."""

    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.name = self.path.name
        self.zipped = self.path.is_file()

    def members(self):
        if self.zipped:
            with zipfile.ZipFile(self.path) as archive:
                for info in archive.infolist():
                    if info.is_dir() or pathlib.PurePosixPath(info.filename).name.startswith("."):
                        continue
                    if info.flag_bits & 1:
                        raise ImportProblem("encrypted archive members are not supported")
                    yield info.filename, info.file_size
        else:
            for directory, _, files in sorted(os.walk(self.path)):
                for name in sorted(files):
                    full = pathlib.Path(directory) / name
                    if not name.startswith(".") and full.is_file() and not full.is_symlink():
                        yield str(full.relative_to(self.path)), full.stat().st_size

    def read(self, member, limit):
        if self.zipped:
            with zipfile.ZipFile(self.path) as archive, archive.open(member) as handle:
                raw = handle.read(limit + 1)
        else:
            with open(self.path / member, "rb") as handle:
                raw = handle.read(limit + 1)
        if len(raw) > limit:
            raise ImportProblem("an archive member exceeds the supported size")
        return raw


def discover(export_dir, stats):
    root = pathlib.Path(export_dir)
    entries = sorted(p for p in root.iterdir() if not p.name.startswith("."))
    stems = {p.stem for p in entries if p.is_file() and p.suffix.lower() == ".zip"}
    archives = []
    for entry in entries:
        if entry.is_symlink():
            continue
        if entry.is_file() and entry.suffix.lower() == ".zip":
            archives.append(Archive(entry))
        elif entry.is_dir() and entry.name in stems:
            stats["quality"]["unpacked_duplicate_archives_skipped"] += 1
        elif entry.is_dir():
            archives.append(Archive(entry))
        else:
            stats["other_files"][entry.suffix.lower() or "(none)"] += 1
    return archives


# --- narrative ------------------------------------------------------------------------------

class Narrative:
    """Section text: rendered body, table rows and the elements entries point at."""

    def __init__(self, text):
        self.targets, self.rows_by_id, self.rows, self.cells = {}, {}, [], []
        chunks = []
        if text is None:
            self.body = ""
            return
        for node in text.iter():
            if node.get("ID"):
                self.targets[node.get("ID")] = node
        if clean(text.text):
            chunks.append(clean(text.text))
        for child in text:
            if local(child.tag) == "table":
                chunks.append(self._table(child))
            else:
                value = text_of(child)
                if value:
                    self.cells.append(value)
                    chunks.append(value)
            if clean(child.tail):
                self.cells.append(clean(child.tail))
                chunks.append(clean(child.tail))
        if clean(text.text):
            self.cells.append(clean(text.text))
        self.body = "\n\n".join(c for c in chunks if c)

    def _table(self, table):
        header_rows = [[clean("".join(th.itertext())) for th in row.findall(HL7 + "th")] for row in table.iter(HL7 + "tr")]
        header_rows = [row for row in header_rows if row] or [[clean("".join(th.itertext())) for th in table.iter(HL7 + "th")]]
        blocks = []
        for row in table.iter(HL7 + "tr"):
            cells = [text_of(td) for td in row.findall(HL7 + "td")]
            if not cells:
                continue
            # Header row with the same width, else the leading columns of a wider one.
            keys = next((h for h in header_rows if len(h) == len(cells)), None) \
                or next((h[:len(cells)] for h in header_rows if len(h) > len(cells)), None) \
                or [f"Column {i + 1}" for i in range(len(cells))]
            record = {k: v for k, v in zip(keys, cells) if v}
            self.rows.append(record)
            self.cells.extend(c for c in cells if c)
            for node in row.iter():
                if node.get("ID"):
                    self.rows_by_id[node.get("ID")] = record
            if len(cells) == 1:
                blocks.append(cells[0])
            else:
                blocks.append("\n".join(f"{k}: {v}" for k, v in record.items()))
        return "\n\n".join(b for b in blocks if b)

    def placeholder(self):
        return not self.cells or all(PLACEHOLDER.match(clean(c)) for c in self.cells)

    def _id(self, element):
        ref = element.find(f"{HL7}text/{HL7}reference") if element is not None else None
        if ref is None and element is not None:
            ref = element.find(f"{HL7}originalText/{HL7}reference")
        value = ref.get("value") if ref is not None else ""
        return value[1:] if value.startswith("#") else None

    def row(self, element):
        return self.rows_by_id.get(self._id(element), {})

    def text(self, element):
        target = self.targets.get(self._id(element))
        if target is not None:
            return text_of(target)
        inline = element.find(HL7 + "text") if element is not None else None
        return text_of(inline) if inline is not None else ""


# --- section extractors ---------------------------------------------------------------------
# Each returns (identity, data, source_data) records. `data` holds flat values the chart shows;
# `source_data` keeps the legacy-list keys read by src/clinical.rs map_source plus all codes.

def entry_identity(element, basis):
    for node in element.findall(HL7 + "id"):
        if node.get("nullFlavor") or not node.get("root"):
            continue
        return node.get("root") + (":" + node.get("extension") if node.get("extension") else "")
    return "sha256:" + digest_of(basis)[:32]


def flat(**values):
    return {k: v for k, v in values.items() if v not in (None, "", [])}


def problems(entry, narrative, stats):
    for act in entry.findall(HL7 + "act"):
        for obs in act.findall(f"{HL7}entryRelationship/{HL7}observation"):
            value, row = obs.find(HL7 + "value"), narrative.row(obs)
            codes = codings(value, stats)
            low, high = interval(obs.find(HL7 + "effectiveTime"), stats)
            title = display(value) or row.get("Problem") or narrative.text(obs)
            status = clean(row.get("Problem Status")) or (act.find(HL7 + "statusCode").get("code") if act.find(HL7 + "statusCode") is not None else "")
            negated = obs.get("negationInd") == "true"
            closed = bool(high) or status.lower() in ("completed", "resolved", "inactive")
            identity = entry_identity(act, [code_text(codes), low, title])
            data = flat(title=("No: " if negated else "") + title, onset=low, resolved=high, status=status.lower(),
                        type=row.get("Problem Type") or display(obs.find(HL7 + "code")), codes=code_text(codes),
                        comments=row.get("Problem Comments"), **author_of(obs))
            source = flat(title=title, begdate=low, enddate=high, activity="0" if closed else "1", diagnosis=code_text(codes),
                          comments=row.get("Problem Comments"), codes=codes, negated=negated or None, entry=xml_json(act, stats))
            yield ("negated" if negated else None), identity, data, source


def medications(entry, narrative, stats):
    for sa in entry.findall(HL7 + "substanceAdministration"):
        material = sa.find(f"{HL7}consumable/{HL7}manufacturedProduct/{HL7}manufacturedMaterial")
        code = material.find(HL7 + "code") if material is not None else None
        codes, row = codings(code, stats), narrative.row(sa)
        low, high = None, None
        for eff in sa.findall(HL7 + "effectiveTime"):
            if eff.find(HL7 + "low") is not None or eff.find(HL7 + "high") is not None:
                low, high = interval(eff, stats)
        title = (clean(material.findtext(HL7 + "name")) if material is not None else "") or display(code) or row.get("Medication") or narrative.text(sa)
        status = clean(row.get("Status")) or (sa.find(HL7 + "statusCode").get("code") if sa.find(HL7 + "statusCode") is not None else "")
        dose, route = sa.find(HL7 + "doseQuantity"), sa.find(HL7 + "routeCode")
        dosage = clean(f"{dose.get('value')} {dose.get('unit') or ''}") if dose is not None and dose.get("value") else ""
        indications = []
        for obs in sa.findall(f"{HL7}entryRelationship/{HL7}observation"):
            indications += codings(obs.find(HL7 + "value"), stats)
        instructions = row.get("Instructions") or ""
        closed = bool(high) or status.lower() in ("completed", "inactive", "discontinued", "stopped")
        comments = "\n".join(x for x in (f"Instructions: {instructions}" if instructions else "",
                                         f"Reason: {row.get('Reason') or code_text(indications)}" if row.get("Reason") or indications else "") if x)
        identity = entry_identity(sa, [code_text(codes), low, title])
        data = flat(title=title, started=low, stopped=high, status=status.lower(), instructions=instructions,
                    reason=row.get("Reason") or code_text(indications), dose=dosage, route=display(route), codes=code_text(codes), **author_of(sa))
        source = flat(title=title, begdate=low, enddate=high, activity="0" if closed else "1", dosage=dosage, route=display(route),
                      diagnosis=code_text(codes), comments=comments, codes=codes, indication_codes=indications, entry=xml_json(sa, stats))
        yield None, identity, data, source


def allergies(entry, narrative, stats):
    for act in entry.findall(HL7 + "act"):
        for obs in act.findall(f"{HL7}entryRelationship/{HL7}observation"):
            agent = obs.find(f"{HL7}participant/{HL7}participantRole/{HL7}playingEntity")
            agent_code = agent.find(HL7 + "code") if agent is not None else None
            codes, row = codings(agent_code, stats), narrative.row(obs)
            title = display(agent_code) or (clean(agent.findtext(HL7 + "name")) if agent is not None else "") \
                or (narrative.text(agent_code) if agent_code is not None else "") or row.get("Substance") or ""
            low, high = interval(obs.find(HL7 + "effectiveTime"), stats)
            reactions, severity = [], ""
            for rel in obs.iter(HL7 + "observation"):
                if rel is obs:
                    continue
                template = [t.get("root") for t in rel.findall(HL7 + "templateId")]
                if "2.16.840.1.113883.10.20.22.4.9" in template:
                    reactions.append(display(rel.find(HL7 + "value")) or narrative.text(rel))
                elif "2.16.840.1.113883.10.20.22.4.8" in template:
                    severity = display(rel.find(HL7 + "value"))
            reaction = "; ".join(r for r in reactions if r) or row.get("Reaction") or ""
            status = clean(row.get("Status")) or (act.find(HL7 + "statusCode").get("code") if act.find(HL7 + "statusCode") is not None else "")
            negated = obs.get("negationInd") == "true"
            kind_of = display(obs.find(HL7 + "value"))
            identity = entry_identity(act, [code_text(codes), title, kind_of, negated])
            data = flat(title=("No known: " + (title or kind_of)) if negated else title, type=kind_of, reaction=reaction,
                        severity=severity or row.get("Severity"), status=status, onset=low, codes=code_text(codes), comments=row.get("Comments"))
            source = flat(title=title, begdate=low, enddate=high, activity="0" if high else "1", reaction=reaction,
                          diagnosis=code_text(codes), comments=row.get("Comments"), codes=codes,
                          type_codes=codings(obs.find(HL7 + "value"), stats), negated=negated or None, entry=xml_json(act, stats))
            yield ("negated" if negated or not title else None), identity, data, source


def encounters(entry, narrative, stats):
    for enc in entry.findall(HL7 + "encounter"):
        code = enc.find(HL7 + "code")
        codes = codings(code, stats)
        low, high = interval(enc.find(HL7 + "effectiveTime"), stats)
        diagnoses = []
        for obs in enc.findall(f"{HL7}entryRelationship/{HL7}act/{HL7}entryRelationship/{HL7}observation"):
            found = codings(obs.find(HL7 + "value"), stats)
            diagnoses.append({"display": display(obs.find(HL7 + "value")), "codes": found})
        performer = person(enc.find(f"{HL7}performer/{HL7}assignedEntity/{HL7}assignedPerson/{HL7}name"))
        location = clean(enc.findtext(f"{HL7}participant/{HL7}participantRole/{HL7}playingEntity/{HL7}name"))
        title = (clean(code.findtext(HL7 + "originalText")) if code is not None else "") or display(code) or "Encounter"
        identity = entry_identity(enc, [low, title, performer])
        data = flat(title=title, date=low, ended=high, performer=performer, location=location, codes=code_text(codes),
                    diagnoses="; ".join(code_text(d["codes"]) or d["display"] for d in diagnoses))
        source = flat(date=low, end_date=high, codes=codes, diagnoses=diagnoses, entry=xml_json(enc, stats),
                      diagnosis_codes=[c for d in diagnoses for c in d["codes"]])
        yield None, identity, data, source


def notes(entry, narrative, stats):
    for act in entry.findall(HL7 + "act"):
        code = act.find(HL7 + "code")
        low, _ = interval(act.find(HL7 + "effectiveTime"), stats)
        body = narrative.text(act)
        encounter = act.find(f"{HL7}entryRelationship/{HL7}encounter")
        encounter_id = entry_identity(encounter, None) if encounter is not None and encounter.find(HL7 + "id") is not None else None
        identity = entry_identity(act, [low, hashlib.sha256(body.encode()).hexdigest()])
        if not body:
            stats["quality"]["notes_without_text"] += 1
        kinds = [t.get("displayName") for t in code.findall(HL7 + "translation") if t.get("displayName")] if code is not None else []
        data = flat(title=clean(kinds[0]) if kinds else display(code, "Clinical note"), date=low, note=body, **author_of(act))
        source = flat(date=low, codes=codings(code, stats), source_encounter=encounter_id,
                      text_sha256=hashlib.sha256(body.encode()).hexdigest(), entry=xml_json(act, stats))
        yield None, identity, data, source


def vitals(entry, narrative, stats):
    for organizer in entry.findall(HL7 + "organizer"):
        low, _ = interval(organizer.find(HL7 + "effectiveTime"), stats)
        components, data = [], {}
        for obs in organizer.findall(f"{HL7}component/{HL7}observation"):
            value, code = obs.find(HL7 + "value"), obs.find(HL7 + "code")
            if value is None or value.get("nullFlavor") or not (value.get("value") or value.get("displayName") or clean(value.text)):
                continue
            reading = clean(f"{value.get('value') or value.get('displayName') or clean(value.text)} {value.get('unit') or ''}")
            name = display(code) or (code.get("code") if code is not None else "") or "observation"
            key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "observation"
            data[key] = reading if key not in data else data[key] + "; " + reading
            components.append(flat(name=name, value=value.get("value"), unit=value.get("unit"), text=reading,
                                   taken=interval(obs.find(HL7 + "effectiveTime"), stats)[0], codes=codings(code, stats)))
        if not components:
            stats["quality"]["vital_sets_without_values"] += 1
            continue
        identity = entry_identity(organizer, [low, components])
        codes = [c for part in components for c in part.get("codes", [])]
        yield None, identity, dict(flat(title="Vital signs", date=low), **data), flat(date=low, components=components, codes=codes, entry=xml_json(organizer, stats))


def immunizations(entry, narrative, stats):
    for sa in entry.findall(HL7 + "substanceAdministration"):
        material = sa.find(f"{HL7}consumable/{HL7}manufacturedProduct/{HL7}manufacturedMaterial")
        code = material.find(HL7 + "code") if material is not None else None
        codes, row = codings(code, stats), narrative.row(sa)
        low, _ = interval(sa.find(HL7 + "effectiveTime"), stats)
        title = display(code) or (clean(material.findtext(HL7 + "name")) if material is not None else "") or row.get("Vaccine Name") or ""
        if not title and not codes:
            continue
        not_given = sa.get("negationInd") == "true"
        status = sa.find(HL7 + "statusCode").get("code") if sa.find(HL7 + "statusCode") is not None else ""
        lot = clean(material.findtext(HL7 + "lotNumberText")) if material is not None else ""
        identity = entry_identity(sa, [code_text(codes), low, title])
        data = flat(title=title, date=low, status="not given" if not_given else status, lot_number=lot, codes=code_text(codes), comments=row.get("Comments"))
        yield None, identity, data, flat(date=low, not_given=not_given or None, lot_number=lot, codes=codes, entry=xml_json(sa, stats))


def insurance(entry, narrative, stats, position=None):
    for act in entry.findall(HL7 + "act"):
        row = narrative.rows[position] if position is not None and position < len(narrative.rows) else {}
        for policy in act.findall(f"{HL7}entryRelationship/{HL7}act") or [act]:
            payer = policy.find(f"{HL7}performer/{HL7}assignedEntity")
            payer_name = clean(payer.findtext(f"{HL7}representedOrganization/{HL7}name")) if payer is not None else ""
            covered = [p for p in policy.findall(HL7 + "participant") if p.get("typeCode") == "COV"]
            holder = [p for p in policy.findall(HL7 + "participant") if p.get("typeCode") == "HLD"]
            member = covered[0].find(f"{HL7}participantRole/{HL7}id") if covered else None
            member_id = member.get("extension") if member is not None else ""
            relationship = display(covered[0].find(f"{HL7}participantRole/{HL7}code")) if covered else ""
            low, high = interval(covered[0].find(HL7 + "time"), stats) if covered else (None, None)
            plan = clean(policy.findtext(f"{HL7}entryRelationship/{HL7}act/{HL7}text"))
            sequence = act.find(f"{HL7}entryRelationship/{HL7}sequenceNumber")
            subscriber = person(holder[0].find(f"{HL7}participantRole/{HL7}playingEntity/{HL7}name")) if holder else ""
            codes = codings(policy.find(HL7 + "code"), stats)
            title = row.get("Insurance Company") or payer_name or row.get("Insurance Provider") or display(policy.find(HL7 + "code")) or "Insurance"
            policy_number = row.get("Insurance Policy ID") or member_id
            identity = entry_identity(policy if policy is not act else act, [title, policy_number, low])
            data = flat(title=title, plan=row.get("Insurance Plan") or plan, policy_id=policy_number, group_number=row.get("Insurance Group Number"),
                        relationship=relationship, subscriber=subscriber, priority=sequence.get("value") if sequence is not None else None,
                        effective=low, ended=high, coverage_type=display(policy.find(HL7 + "code")))
            day = lambda value: value[:10] if value and re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", value) else None  # noqa: E731
            kin = next((native for word, native in RELATIONSHIPS if word in relationship.lower()), "other") if relationship else None
            # The fields the coverage form asks for, so staff confirm rather than re-key.
            coverage = flat(payer_name=title if title != "Insurance" else None, member_id=policy_number, group_number=data.get("group_number"),
                            plan_name=data.get("plan"), subscriber_name=subscriber, relationship=kin,
                            priority={"1": "primary", "2": "secondary", "3": "tertiary"}.get(data.get("priority")),
                            effective_date=day(low), end_date=day(high))
            yield None, identity, data, flat(narrative=row or None, codes=codes, coverage=coverage, entry=xml_json(act, stats))


def results(entry, narrative, stats):
    groups = entry.findall(HL7 + "organizer") or entry.findall(HL7 + "observation")
    for group in groups:
        observations = group.findall(f"{HL7}component/{HL7}observation") if local(group.tag) == "organizer" else [group]
        low, _ = interval(group.find(HL7 + "effectiveTime"), stats)
        rows = []
        for obs in observations:
            value, code = obs.find(HL7 + "value"), obs.find(HL7 + "code")
            reading = ""
            if value is not None and not value.get("nullFlavor"):
                reading = clean(f"{value.get('value') or value.get('displayName') or clean(value.text)} {value.get('unit') or ''}")
            rows.append(flat(name=display(code) or narrative.row(obs).get("Name"), value=reading, date=interval(obs.find(HL7 + "effectiveTime"), stats)[0],
                             interpretation=display(obs.find(HL7 + "interpretationCode")), codes=codings(code, stats),
                             status=obs.find(HL7 + "statusCode").get("code") if obs.find(HL7 + "statusCode") is not None else None))
        title = display(group.find(HL7 + "code")) or (rows[0].get("name") if rows else "") or "Result"
        identity = entry_identity(group, [low, title, rows])
        codes = codings(group.find(HL7 + "code"), stats) if local(group.tag) == "organizer" else []
        codes += [c for r in rows for c in r.get("codes", []) if c not in codes]
        data = flat(title=title, date=low or (rows[0].get("date") if rows else None),
                    results="\n".join(f"{r.get('name', 'Result')}: {r.get('value', 'no value recorded')}" for r in rows))
        yield None, identity, data, flat(date=low, results=rows, codes=codes, entry=xml_json(group, stats))


def procedures(entry, narrative, stats):
    for proc in [c for c in entry if local(c.tag) in ("procedure", "act", "observation")]:
        code = proc.find(HL7 + "code")
        codes = codings(code, stats)
        low, high = interval(proc.find(HL7 + "effectiveTime"), stats)
        body, row = narrative.text(proc), narrative.row(proc)
        title = display(code) or row.get("Procedure/Surgery/Device") or (body.split("\n")[0][:200] if body else "") or "Procedure"
        status = proc.find(HL7 + "statusCode").get("code") if proc.find(HL7 + "statusCode") is not None else ""
        identity = entry_identity(proc, [code_text(codes), low, high, body])
        data = flat(title=title, date=low, ended=high, status=status, codes=code_text(codes), description=body if body != title else "", comments=row.get("Comments"))
        yield None, identity, data, flat(date=low, end_date=high, codes=codes, entry=xml_json(proc, stats))


def referrals(entry, narrative, stats):
    for act in entry.findall(HL7 + "act"):
        low, _ = interval(act.find(HL7 + "effectiveTime"), stats)
        reasons = []
        for obs in act.findall(f"{HL7}entryRelationship/{HL7}observation"):
            reasons.append({"display": display(obs.find(HL7 + "value")), "codes": codings(obs.find(HL7 + "value"), stats)})
        codes = codings(act.find(HL7 + "code"), stats)
        identity = entry_identity(act, [low, reasons])
        data = flat(title=display(act.find(HL7 + "code"), "Referral"), date=low, priority=display(act.find(HL7 + "priorityCode")),
                    status=act.find(HL7 + "statusCode").get("code") if act.find(HL7 + "statusCode") is not None else None,
                    reasons="; ".join(code_text(r["codes"]) or r["display"] for r in reasons))
        yield None, identity, data, flat(date=low, codes=codes + [c for r in reasons for c in r["codes"]], reasons=reasons, entry=xml_json(act, stats))


EXTRACTORS = {"medical_problem": problems, "medication": medications, "allergy": allergies, "encounter": encounters,
              "soap_note": notes, "vital": vitals, "immunization": immunizations, "insurance": insurance,
              "lab_result": results, "procedure": procedures, "referral": referrals}


# --- documents and patients -----------------------------------------------------------------

def patient_identity(root, stats):
    role = root.find(f"{HL7}recordTarget/{HL7}patientRole")
    if role is None:
        raise ImportProblem("document has no patient")
    identifier = None
    for node in role.findall(HL7 + "id"):
        if (node.get("root") or "").startswith(SENSITIVE_ID_ROOTS):
            stats["quality"]["government_identifiers_dropped"] += 1
        elif identifier is None and node.get("root") and node.get("extension") and not node.get("nullFlavor"):
            identifier = (node.get("root"), clean(node.get("extension")))
    if identifier is None:
        raise ImportProblem("patient has no source identifier")
    patient = role.find(HL7 + "patient")
    name = patient.find(HL7 + "name") if patient is not None else None
    given = " ".join(clean(g.text) for g in name.findall(HL7 + "given") if clean(g.text)) if name is not None else ""
    family = clean(name.findtext(HL7 + "family")) if name is not None else ""
    birth = (timestamp(patient.find(HL7 + "birthTime")) or "")[:10] if patient is not None else ""
    address = role.find(HL7 + "addr")
    demographics = flat(
        sex=display(patient.find(HL7 + "administrativeGenderCode")) or (patient.find(HL7 + "administrativeGenderCode").get("code") if patient.find(HL7 + "administrativeGenderCode") is not None else None),
        address=", ".join(clean(part.text) for part in address if clean(part.text)) if address is not None else None,
        marital_status=display(patient.find(HL7 + "maritalStatusCode")), race=display(patient.find(HL7 + "raceCode")),
        ethnicity=display(patient.find(HL7 + "ethnicGroupCode")),
        language=(patient.find(f"{HL7}languageCommunication/{HL7}languageCode").get("code") if patient.find(f"{HL7}languageCommunication/{HL7}languageCode") is not None else None),
        guardian=person(patient.find(f"{HL7}guardian/{HL7}guardianPerson/{HL7}name")),
        guardian_relationship=display(patient.find(f"{HL7}guardian/{HL7}code"))) if patient is not None else {}
    contacts = collections.defaultdict(list)
    for telecom in role.findall(HL7 + "telecom"):
        value = telecom.get("value") or ""
        if ":" in value:
            scheme, rest = value.split(":", 1)
            label = {"tel": "phone", "mailto": "email"}.get(scheme, scheme) + {"HP": "_home", "MC": "_mobile", "WP": "_work", "HV": "_other"}.get(telecom.get("use") or "", "")
            if clean(rest) and clean(rest) not in contacts[label]:
                contacts[label].append(clean(rest))
    demographics.update({k: "; ".join(v) for k, v in contacts.items()})
    return {"id_root": identifier[0], "id": identifier[1], "given": given, "family": family, "birth": birth,
            "gender": patient.find(HL7 + "administrativeGenderCode").get("code") if patient is not None and patient.find(HL7 + "administrativeGenderCode") is not None else None,
            "demographics": demographics, "contact": structured_contact(role, patient)}


LANGUAGES = {"en": "English", "eng": "English", "es": "Spanish", "spa": "Spanish", "fr": "French", "fra": "French", "fre": "French",
             "zh": "Chinese", "zho": "Chinese", "chi": "Chinese", "vi": "Vietnamese", "vie": "Vietnamese", "ar": "Arabic", "ara": "Arabic",
             "ko": "Korean", "kor": "Korean", "ru": "Russian", "rus": "Russian", "de": "German", "deu": "German", "ger": "German",
             "pt": "Portuguese", "por": "Portuguese", "it": "Italian", "ita": "Italian", "ja": "Japanese", "jpn": "Japanese",
             "hi": "Hindi", "hin": "Hindi", "tl": "Tagalog", "tgl": "Tagalog", "pl": "Polish", "pol": "Polish", "ht": "Haitian Creole", "hat": "Haitian Creole"}
SEXES = {"f": "female", "female": "female", "m": "male", "male": "male", "un": "other", "other": "other", "unk": "unknown", "unknown": "unknown"}
COUNTRIES = {"USA": "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US"}
RELATIONSHIPS = (("self", "self"), ("spouse", "spouse"), ("sps", "spouse"), ("husband", "spouse"), ("wife", "spouse"),
                 ("child", "child"), ("son", "child"), ("daughter", "child"), ("chd", "child"))


def structured_contact(role, patient):
    """Contact details in the shape of the chart's own contact profile (src/demographics.rs).

    Values the profile would reject are left out here; the unstructured demographics
    record still shows everything the previous system held.
    """
    out, address = {}, role.find(HL7 + "addr")
    if address is not None and not address.get("nullFlavor"):
        lines = [clean(n.text) for n in address.findall(HL7 + "streetAddressLine") if clean(n.text)]
        country = clean(address.findtext(HL7 + "country")).upper()
        country = COUNTRIES.get(country, country)
        parts = flat(line1=lines[0][:200] if lines else None, line2=", ".join(lines[1:])[:200] or None,
                     city=clean(address.findtext(HL7 + "city"))[:100], region=clean(address.findtext(HL7 + "state"))[:100],
                     postal_code=clean(address.findtext(HL7 + "postalCode"))[:32], country=country if re.fullmatch(r"[A-Z]{2}", country) else None)
        if parts:
            out["address"] = parts
    phones, emails = [], []
    for telecom in role.findall(HL7 + "telecom"):
        scheme, _, rest = (telecom.get("value") or "").partition(":")
        rest = clean(urllib.parse.unquote(rest))
        if scheme == "tel" and re.fullmatch(r"[0-9+(). xX#-]{1,40}", rest) and re.search(r"[0-9]", rest):
            phones.append(({"MC": 0, "HP": 1, "WP": 3}.get(telecom.get("use") or "", 2), len(phones), rest))
        elif scheme == "mailto" and len(rest) <= 254 and re.fullmatch(r"[^@\s]+@[^@\s.][^@\s]*\.[^@\s.]+", rest):
            emails.append(rest)
    if phones:
        out["phone"] = min(phones)[2]  # mobile, then home, then unlabelled, then work
    if emails:
        out["email"] = emails[0]
    if patient is not None:
        gender = patient.find(HL7 + "administrativeGenderCode")
        sex = SEXES.get((gender.get("code") or "").lower()) or SEXES.get((gender.get("displayName") or "").lower()) if gender is not None else None
        if sex:
            out["administrative_gender"] = sex
        language = patient.find(f"{HL7}languageCommunication/{HL7}languageCode")
        code = clean(language.get("code")) if language is not None else ""
        if code:
            out["language"] = LANGUAGES.get(re.split(r"[-_]", code.lower())[0], code)[:100]
    return out


def looks_like_test(patient):
    tokens = re.findall(r"[a-z0-9]+", f"{patient['family']} {patient['given']}".lower())
    return any(TEST_NAME.match(token) for token in tokens)


def split_note(kind, identity, data, source):
    """Long narrative becomes ordered parts so every record fits one API request."""
    key = "note" if "note" in data else "text"
    body = data.get(key, "")
    if len(body.encode()) <= NOTE_PART_BYTES:
        return [(identity, data, source)]
    parts, current = [], ""
    for line in body.split("\n"):
        while len(line.encode()) > NOTE_PART_BYTES:
            cut = len(line.encode()[:NOTE_PART_BYTES].decode("utf-8", "ignore"))
            parts.append(current + line[:cut]) if not current else parts.extend([current, line[:cut]])
            current, line = "", line[cut:]
        if current and len((current + "\n" + line).encode()) > NOTE_PART_BYTES:
            parts.append(current)
            current = line
        else:
            current = current + "\n" + line if current else line
    if current:
        parts.append(current)
    out = []
    for index, part in enumerate(parts, 1):
        part_data = dict(data, **{key: part, "title": f"{data.get('title', kind)} (part {index} of {len(parts)})"})
        part_source = dict(source, part=index, parts=len(parts))
        if index > 1:
            part_source.pop("entry", None)
        out.append((identity if index == 1 else f"{identity}#part{index}", part_data, part_source))
    return out


def read_document(raw, stats):
    root = parse_xml(raw)
    if local(root.tag) != "ClinicalDocument":
        raise ImportProblem("not a C-CDA ClinicalDocument")
    patient = patient_identity(root, stats)
    doc_id = root.find(HL7 + "id")
    meta = {"effective": timestamp(root.find(HL7 + "effectiveTime")) or "",
            "id": (doc_id.get("root") or "") + ":" + (doc_id.get("extension") or "") if doc_id is not None else "",
            "organization": clean(root.findtext(f"{HL7}custodian/{HL7}assignedCustodian/{HL7}representedCustodianOrganization/{HL7}name"))}
    records, presence = [], {}
    for section in root.iter(HL7 + "section"):
        code = section.find(HL7 + "code")
        loinc = code.get("code") if code is not None else ""
        title = clean(section.findtext(HL7 + "title"))
        name, kind = SECTIONS.get(loinc, (title or loinc or "Untitled section", "form"))
        if loinc not in SECTIONS:
            stats["unrecognized_sections"][name] += 1
        narrative = Narrative(section.find(HL7 + "text"))
        entries = section.findall(HL7 + "entry")
        produced, leftovers = 0, []
        extractor = EXTRACTORS.get(kind)
        for position, entry in enumerate(entries):
            if not extractor:
                leftovers.append(entry)
                continue
            try:
                found = list(extractor(entry, narrative, stats, position if len(narrative.rows) == len(entries) else None)
                             if kind == "insurance" else extractor(entry, narrative, stats))
            except (AttributeError, KeyError, IndexError, TypeError, ValueError):
                stats["quality"]["unparseable_entries"] += 1
                stats["unparseable_by_section"][name] += 1
                continue
            for flag, identity, data, source in found:
                if flag == "negated":
                    # "No known ..." assertions are history, not list entries awaiting reconciliation.
                    stats["quality"][f"negated_{kind}_assertions_kept_as_narrative"] += 1
                    records.append(("form", name, loinc, f"{loinc}/{identity}",
                                    dict(data, title=f"{name}: {data.get('title', 'no known entries')}"), dict(source, section=name, section_code=loinc)))
                else:
                    for part_id, part_data, part_source in split_note(kind, identity, data, source):
                        records.append((kind, name, loinc, f"{loinc}/{part_id}", part_data, dict(part_source, section=name, section_code=loinc)))
                produced += 1
            if not found:
                leftovers.append(entry)
        narrative_only = kind == "form" or (not produced and not narrative.placeholder())
        if narrative_only and not narrative.placeholder():
            body = narrative.body
            identity = "sha256:" + hashlib.sha256((loinc + "\n" + body).encode()).hexdigest()[:32]
            data = flat(title=name, text=body, recorded_by=meta["organization"])
            source = flat(section=name, section_code=loinc, section_title=title, text_sha256=hashlib.sha256(body.encode()).hexdigest(),
                          codes=[c for e in entries for node in e.iter() if local(node.tag) in ("value", "code") for c in codings(node, stats)
                                 if c.get("system") != "LOINC" or local(node.tag) == "value"] or None,
                          entries=[xml_json(e, stats) for e in entries] or None)
            for part_id, part_data, part_source in split_note("form", identity, data, source):
                records.append(("form", name, loinc, f"{loinc}/{part_id}", part_data, part_source))
            produced += 1
            if kind != "form":
                stats["quality"]["mapped_sections_kept_as_narrative_only"] += 1
                stats["narrative_only_by_section"][name] += 1
        presence[name] = "entries" if produced else "placeholder"
    return patient, meta, records, presence


# Identity normalization, applied identically here and in MATCH_SQL: accents folded by this
# fixed table, ASCII letters lower-cased, everything else removed.
FOLD_FROM = "ÁÀÂÄÃÅáàâäãåÇçÉÈÊËéèêëÍÌÎÏíìîïÑñÓÒÔÖÕØóòôöõøÚÙÛÜúùûüÝýÿ" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
FOLD_TO = "aaaaaaaaaaaacceeeeeeeeiiiiiiiinnoooooooooooouuuuuuuuyyy" + "abcdefghijklmnopqrstuvwxyz"


def identity_hashes(salt, family, given, birth):
    def norm(value):
        return re.sub(r"[^a-z]", "", value.translate(str.maketrans(FOLD_FROM, FOLD_TO)))
    fam, first = norm(family), norm(given.strip(" ").split(" ")[0])
    def sha(variant, *parts):
        return hashlib.sha256("|".join((salt, variant) + parts).encode()).hexdigest()
    return {"v1": sha("v1", fam, first, birth), "v2": sha("v2", fam, first[:1], birth), "v3": sha("v3", first, birth)}


MATCH_SQL = """-- Read-only overlap check. Contains salted hashes only; keep it private all the same.
-- v1 = family name + first given name + birth date; v2 = family name + first initial + birth date;
-- v3 = first given name + birth date (catches a changed or misspelt family name; review by hand).
-- Optional: it only tells you beforehand how many patients the Data import page will ask you
-- to attach or create. The page does the matching itself; nothing here changes the database.
BEGIN TRANSACTION READ ONLY;
WITH staged(variant, hash) AS (VALUES
{values}
), existing AS (
  SELECT tenant_id, id,
         regexp_replace(translate(family_name, '{fold_from}', '{fold_to}'), '[^a-z]', '', 'g') AS fam,
         regexp_replace(translate(split_part(btrim(given_name, ' '), ' ', 1), '{fold_from}', '{fold_to}'), '[^a-z]', '', 'g') AS giv,
         to_char(birth_date, 'YYYY-MM-DD') AS dob
  FROM patients
  -- WHERE tenant_id = '<practice tenant uuid>'   -- add when the database holds more than one practice
), hashed AS (
  SELECT tenant_id, id, 'v1' AS variant, encode(sha256(convert_to('{salt}|v1|' || fam || '|' || giv || '|' || dob, 'UTF8')), 'hex') AS hash FROM existing
  UNION ALL
  SELECT tenant_id, id, 'v2', encode(sha256(convert_to('{salt}|v2|' || fam || '|' || left(giv, 1) || '|' || dob, 'UTF8')), 'hex') FROM existing
  UNION ALL
  SELECT tenant_id, id, 'v3', encode(sha256(convert_to('{salt}|v3|' || giv || '|' || dob, 'UTF8')), 'hex') FROM existing
)
SELECT s.variant, s.hash, count(*) OVER (PARTITION BY s.variant) AS matches_for_variant
FROM staged s JOIN hashed h USING (variant, hash)
ORDER BY s.variant, s.hash;
ROLLBACK;
"""


def category_for(name):
    words = re.sub(r"[_\-.]+", " ", name.lower())
    for category, pattern in DOCUMENT_CATEGORIES:
        if re.search(pattern, words):
            return category
    return "other"


def sniff(raw):
    if raw.startswith(b"%PDF-"):
        return "application/pdf", b"%%EOF" in raw
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", True
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", raw.endswith(b"\xff\xd9")
    if raw[4:8] == b"ftyp" and raw[8:12] in (b"heic", b"heix", b"hevc", b"mif1", b"msf1", b"heim", b"heis"):
        return "image/heic", False
    head = raw[:2048].lstrip().lower()
    if head.startswith((b"<!doctype html", b"<html")) or b"<body" in head:
        return "text/html", False
    return "application/octet-stream", False


def plan_attachment(member, raw):
    kind, accepted = sniff(raw)
    entry = {"member": member, "detected_type": kind, "size_bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
             "category": category_for(pathlib.PurePosixPath(member).name)}
    if kind == "text/html":
        entry.update(upload_type="text/plain", conversion="html_to_text")
    elif kind == "image/heic":
        entry.update(upload_type="image/jpeg", conversion="heic_to_jpeg")
    elif kind == "image/jpeg" and not accepted:
        entry.update(upload_type="image/jpeg", conversion="reencode_jpeg")
    elif kind == "application/pdf" and not accepted:
        entry.update(upload_type=None, conversion="unsupported", reason="PDF has no end-of-file marker")
    elif kind == "application/octet-stream":
        entry.update(upload_type=None, conversion="unsupported", reason="file type is not accepted by patient documents")
    else:
        entry.update(upload_type=kind, conversion="none")
    if entry["conversion"] in ("none", "reencode_jpeg") and len(raw) > MAX_DOCUMENT_BYTES:
        entry.update(upload_type=None, conversion="unsupported", reason="file exceeds 10 MiB")
    return entry


# --- packaging ------------------------------------------------------------------------------

def new_stats():
    return {"quality": collections.Counter(), "other_files": collections.Counter(), "unrecognized_sections": collections.Counter(),
            "unparseable_by_section": collections.Counter(), "narrative_only_by_section": collections.Counter(),
            "skipped_files": collections.Counter()}


def collect(export_dir, source_instance, revision, *, mrn_prefix="IM", keep_test=False, exclude_labels=(), salt=None):
    """Parse every archive. Returns (packages, private, report); only `report` is free of patient data."""
    stats = new_stats()
    salt = salt or secrets.token_hex(16)
    archives = discover(export_dir, stats)
    index, items, attachments, hashes = [], [], [], []
    section_presence = collections.defaultdict(collections.Counter)
    counters = collections.Counter()
    seen_patients = {}
    per_patient_history = []
    for number, archive in enumerate(archives, 1):
        label = f"P{number:02d}"
        entry = {"label": label, "archive": archive.name, "status": "imported", "documents": 0}
        index.append(entry)
        totals, stats, members = stats, new_stats(), []  # counted only if this patient is staged
        try:
            members = list(archive.members())
            documents, files = [], []
            for member, size in members:
                if member.lower().endswith(".xml"):
                    if size > MAX_XML_BYTES:
                        raise ImportProblem("document exceeds the supported size")
                    raw = archive.read(member, MAX_XML_BYTES)
                    documents.append(read_document(raw, stats) + (hashlib.sha256(raw).hexdigest(),))
                else:
                    files.append((member, size))
            if not documents:
                raise ImportProblem("archive has no clinical document")
            if len({doc[4] for doc in documents}) < len(documents):
                stats["quality"]["duplicate_documents"] += len(documents) - len({doc[4] for doc in documents})
            if len({(doc[0]["id_root"], doc[0]["id"]) for doc in documents}) != 1:
                raise ImportProblem("archive mixes documents of different patients")
            documents.sort(key=lambda doc: (doc[1]["effective"], doc[1]["id"]))
            patient = documents[-1][0]
            entry.update(documents=len(documents), patient_source_id=patient["id"])
            if len(documents) > 1:
                counters["patients_with_several_documents"] += 1
            if not patient["birth"] or len(patient["birth"]) != 10:
                stats["quality"]["patients_missing_birth_date"] += 1
                raise ImportProblem("patient has no complete birth date")
            if not patient["given"] or not patient["family"] or len(patient["given"]) > 100 or len(patient["family"]) > 100:
                stats["quality"]["patients_missing_name"] += 1
                raise ImportProblem("patient name is missing or too long")
            birth = datetime.date.fromisoformat(patient["birth"])
            if birth > datetime.date.today() or birth.year < 1800:
                stats["quality"]["patients_invalid_birth_date"] += 1
                raise ImportProblem("patient birth date is not plausible")
            if patient["id"] in seen_patients:
                stats["quality"]["patients_in_more_than_one_archive"] += 1
                raise ImportProblem("patient already appeared in another archive")
            seen_patients[patient["id"]] = label
            entry["test_record"] = looks_like_test(patient)
            if (entry["test_record"] and not keep_test) or label in exclude_labels:
                entry["status"] = "excluded_test_record" if entry["test_record"] and not keep_test else "excluded_by_operator"
                counters[entry["status"]] += 1
                stats = new_stats()
                stats["skipped_files"]["files_of_excluded_patients"] = len(files)
                stats["skipped_files"]["bytes_of_excluded_patients"] = sum(size for _, size in files)
                continue
            pid = patient["id"]
            mrn = f"{mrn_prefix}-{hashlib.sha256((patient['id_root'] + ':' + pid).encode()).hexdigest()[:12].upper()}"
            entry["mrn"] = mrn
            hashes.append({"label": label, **identity_hashes(salt, patient["family"], patient["given"], patient["birth"])})
            target = items
            # `contact` fills a new chart's contact details; an existing chart is never overwritten.
            patient_item = {"kind": "patient", "source_id": pid, "patient_source_id": None,
                            "data": {"mrn": mrn, "given_name": patient["given"], "family_name": patient["family"], "birth_date": patient["birth"]},
                            "source_data": flat(format="hl7-ccda", id_root=patient["id_root"], id=pid, administrative_gender=patient["gender"],
                                                contact=patient["contact"] or None)}
            target.append(patient_item)
            merged = {}
            if patient["demographics"]:
                merged[("form", "demographics")] = ("Demographics", dict(title="Demographics (previous record system)", **patient["demographics"]),
                                                    flat(format="hl7-ccda", section="Demographics", demographics=patient["demographics"],
                                                         contact=patient["contact"] or None))
            presence = {}
            for _, meta, records, doc_presence, _ in documents:
                for name, state in doc_presence.items():
                    if presence.get(name) != "entries":
                        presence[name] = state
                local_seen = {}
                for kind, name, loinc, identity, data, source in records:
                    source = dict(source, format="hl7-ccda")
                    key = (kind, identity)
                    if key in local_seen and local_seen[key] != digest_of([data, source]):
                        stats["quality"]["repeated_identifiers_with_different_content"] += 1
                        key = (kind, identity + "~" + digest_of([data, source])[:8])
                    elif key in local_seen:
                        stats["quality"]["duplicate_entries_within_document"] += 1
                        continue
                    local_seen[key] = digest_of([data, source])
                    if key in merged:
                        counter = "entries_repeated_across_documents" if digest_of([merged[key][1], merged[key][2]]) == local_seen[key] else "entries_superseded_by_later_document"
                        stats["quality"][counter] += 1
                    merged[key] = (name, data, source)
            for name, state in presence.items():
                section_presence[name][state] += 1
            count = 0
            for (kind, identity), (name, data, source) in sorted(merged.items()):
                source_id = f"{pid}/{identity}"
                if len(source_id) > 200:
                    source_id = f"{pid}/sha256:{hashlib.sha256(identity.encode()).hexdigest()[:40]}"
                item = {"kind": kind, "source_id": source_id, "patient_source_id": pid, "data": data, "source_data": source}
                if len(canonical(item).encode()) > MAX_ITEM_BYTES and "entry" in source:
                    item["source_data"] = dict({k: v for k, v in source.items() if k not in ("entry", "entries")}, entry_omitted="source entry exceeds the staged record size")
                    stats["quality"]["oversized_source_entries_trimmed"] += 1
                if len(canonical(item).encode()) > MAX_ITEM_BYTES:
                    stats["quality"]["records_too_large_to_stage"] += 1
                    continue
                if contains_credentials(item):
                    stats["quality"]["records_with_credential_like_fields"] += 1
                    continue
                target.append(item)
                count += 1
            per_patient_history.append(count)
            file_hashes = set()
            for member, size in files:
                if size > MAX_FILE_BYTES:
                    attachments.append({"label": label, "patient_source_id": pid, "member": member, "size_bytes": size, "detected_type": "unknown",
                                        "upload_type": None, "conversion": "unsupported", "reason": "file exceeds the supported size"})
                    continue
                plan = plan_attachment(member, archive.read(member, MAX_FILE_BYTES))
                if plan["sha256"] in file_hashes:
                    stats["quality"]["duplicate_attachments_within_patient"] += 1
                    continue
                file_hashes.add(plan["sha256"])
                plan.update(label=label, archive=archive.name, patient_source_id=pid, mrn=mrn,
                            request_id=str(uuid.uuid5(UUID_NAMESPACE, f"{source_instance}|{pid}|{plan['sha256']}")))
                attachments.append(plan)
        except (ImportProblem, zipfile.BadZipFile, OSError, UnicodeError) as error:
            entry["status"] = "failed"
            entry["reason"] = str(error) if isinstance(error, ImportProblem) else type(error).__name__
            counters["failed"] += 1
            stats = {"quality": collections.Counter({k: v for k, v in stats["quality"].items() if k.startswith("patients_")}),
                     "skipped_files": collections.Counter(files_of_failed_patients=sum(1 for m, _ in members if not m.lower().endswith(".xml")))}
        finally:
            for name, counter in stats.items():
                totals[name].update(counter)
            stats = totals
    if len(items) > MAX_JOB_ITEMS:
        raise ImportProblem("package exceeds the 100000 record job limit")
    report = build_report(index, items, attachments, stats, section_presence, counters, per_patient_history)
    limitations = [
        "Operator asserted a read-only source export; a frozen source was not independently verified.",
        "C-CDA health summaries only: sections the previous system left empty or did not export are absent.",
        "Patients who look like an existing chart are attached to it or created as new charts by the owner's decision before import.",
        "New charts get name, birth date, a generated MRN and contact details; insurance and every clinical section are preserved as read-only source history.",
        "Problems, medications and allergies need clinician reconciliation before they appear in the native lists; their source codes are carried over.",
        "Attached files are not part of this package and are uploaded separately as patient documents.",
    ]

    counts = dict(sorted(collections.Counter(r["kind"] for r in items).items()))
    counts.setdefault("patient", 0)
    package = {"manifest": {"source_instance": source_instance, "source_revision": revision, "expected_counts": counts,
                            "consistency": "read_only_export", "limitations": limitations}, "items": items}
    private = {"index": index, "hashes": {"salt": salt, "normalization": "accents folded, ASCII letters only, lower case; first given name; birth date YYYY-MM-DD", "patients": hashes},
               "attachments": attachments}
    return {"package": package}, private, report


def build_report(index, items, attachments, stats, section_presence, counters, per_patient_history):
    statuses = collections.Counter(e["status"] for e in index)
    included = statuses["imported"]
    coverage, fields = {}, {}
    contact = collections.Counter()
    for item in items:
        if item["kind"] == "patient":
            contact.update(item["source_data"].get("contact", {}).keys())
        if item["kind"] == "insurance":
            contact.update("coverage_" + key for key in item["source_data"].get("coverage", {}))
    for item in items:
        present = fields.setdefault(item["kind"], collections.Counter())
        present["records"] += 1
        present.update(item["data"].keys())
        if item["kind"] == "patient":
            continue
        bucket = coverage.setdefault(item["kind"], collections.Counter())
        bucket["records"] += 1
        systems = {c["system"] for c in item["source_data"].get("codes") or []}
        systems |= {"diagnosis: " + c["system"] for c in item["source_data"].get("diagnosis_codes") or []}
        for system in systems:
            bucket[system] += 1
        if not systems:
            bucket["(no code)"] += 1
    for kind in ("vital", "form"):  # free-form keys: report the fixed ones only
        if kind in fields:
            fields[kind] = collections.Counter({k: v for k, v in fields[kind].items() if k in ("records", "title", "date", "text", "recorded_by")})
    by_type = {}
    for plan in attachments:
        bucket = by_type.setdefault(plan["detected_type"], collections.Counter())
        bucket["files"] += 1
        bucket["bytes"] += plan["size_bytes"]
        bucket["ready" if plan["conversion"] == "none" else plan["conversion"]] += 1
    sections = {}
    for name, states in sorted(section_presence.items()):
        sections[name] = {"patients_with_entries": states["entries"], "patients_with_placeholder_only": states["placeholder"],
                          "patients_without_section": included - states["entries"] - states["placeholder"],
                          "import_kind": dict((v[0], v[1]) for v in SECTIONS.values()).get(name, "form")}
    return {
        "archives": len(index), "patients_parsed": len(index) - statuses["failed"], "patients_staged": statuses["imported"],
        "patients_excluded_as_test_records": statuses["excluded_test_record"], "patients_excluded_by_operator": statuses["excluded_by_operator"],
        "patients_failed": statuses["failed"], "failure_reasons": dict(collections.Counter(e.get("reason") for e in index if e["status"] == "failed")),
        "patients_with_several_documents": counters["patients_with_several_documents"], "documents": sum(e["documents"] for e in index),
        "staged_counts": dict(sorted(collections.Counter(i["kind"] for i in items).items())),
        "structured_fields": dict(sorted(contact.items())),
        "sections": sections, "code_coverage": {k: dict(sorted(v.items())) for k, v in sorted(coverage.items())},
        "field_coverage": {k: dict(sorted(v.items())) for k, v in sorted(fields.items())},
        "sections_kept_as_narrative_only": dict(stats["narrative_only_by_section"]), "skipped_files": dict(stats["skipped_files"]),
        "attachments": {"total_files": len(attachments), "total_bytes": sum(p["size_bytes"] for p in attachments),
                        "mapped_to_one_patient": sum(1 for p in attachments if p.get("patient_source_id")),
                        "by_type": {k: dict(v) for k, v in sorted(by_type.items())}},
        "history_view": {"limit_per_patient": HISTORY_VIEW_LIMIT, "largest_patient_record_count": max(per_patient_history, default=0),
                         "patients_over_limit": sum(1 for n in per_patient_history if n > HISTORY_VIEW_LIMIT)},
        "quality": dict(sorted(stats["quality"].items())), "unparseable_by_section": dict(stats["unparseable_by_section"]),
        "unrecognized_sections": len(stats["unrecognized_sections"]), "other_top_level_files": dict(stats["other_files"]),
    }


def batches(package):
    batch, size = [], 12
    for item in package["items"]:
        length = len(json.dumps(item, ensure_ascii=False).encode()) + 1
        if batch and (size + length > MAX_BATCH_BYTES or len(batch) >= MAX_BATCH_ITEMS):
            yield batch
            batch, size = [], 12
        batch.append(item)
        size += length
    if batch:
        yield batch


def private_directory(path, export_dir):
    work = pathlib.Path(path).resolve()
    source = pathlib.Path(export_dir).resolve()
    if work == source or source in work.parents or work in source.parents:
        raise ImportProblem("the work directory must be separate from the export")
    work.mkdir(mode=0o700, exist_ok=True)
    mode = stat.S_IMODE(work.stat().st_mode)
    if mode & 0o077 or work.stat().st_uid != os.getuid():
        raise ImportProblem("the work directory must be owned by you with mode 0700")
    return work


def write_private(path, text):
    path = pathlib.Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".ccda-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=1) + "\n"


def write_outputs(work, packages, private, report, source_instance):
    write_private(work / "package.json", json.dumps(packages["package"], ensure_ascii=False) + "\n")
    for stale in ("package-held-matches.json", "link-existing-patients.sql"):  # outputs of earlier versions
        if (work / stale).exists():
            (work / stale).unlink()
    folder = work / "batches"
    folder.mkdir(mode=0o700, exist_ok=True)
    for stale in folder.glob("batch-*.json"):
        stale.unlink()
    write_private(folder / "manifest.json", dump(packages["package"]["manifest"]))
    count = 0
    for count, batch in enumerate(batches(packages["package"]), 1):
        write_private(folder / f"batch-{count:04d}.json", json.dumps({"items": batch}, ensure_ascii=False) + "\n")
    report["package"] = {"batches": count, "bytes": (work / "package.json").stat().st_size,
                         "fits_data_import_upload": (work / "package.json").stat().st_size <= 8 * 1024 * 1024}
    write_private(work / "patient-index.json", dump(private["index"]))
    write_private(work / "match-hashes.json", dump(private["hashes"]))
    values = ",\n".join(f"  ('{variant}', '{row[variant]}')" for row in private["hashes"]["patients"] for variant in ("v1", "v2", "v3"))
    write_private(work / "match-query.sql", MATCH_SQL.format(values=values or "  ('v1', '')", salt=private["hashes"]["salt"], fold_from=FOLD_FROM, fold_to=FOLD_TO))
    write_private(work / "attachments.json", dump(private["attachments"]))
    write_private(work / "report.json", dump(report))


# --- attachment upload ----------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never send a bearer token to a redirected destination.


class Api:
    def __init__(self, base, token):
        uri = urllib.parse.urlsplit(base)
        if (uri.scheme != "https" and not (uri.scheme == "http" and uri.hostname in {"localhost", "127.0.0.1", "::1"})) or uri.username or uri.password or uri.query or uri.fragment:
            raise ImportProblem("Use an HTTPS API base, or loopback HTTP for synthetic testing")
        if not token:
            raise ImportProblem("SUNCHARTS_ACCESS_TOKEN must be set in the environment")
        self.base, self.token = base.rstrip("/"), token
        self.opener = urllib.request.build_opener(NoRedirect)

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=120) as response:
                return json.loads(response.read(32 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            raise ImportProblem(f"request failed (HTTP {error.code})") from None
        except (urllib.error.URLError, ValueError):
            raise ImportProblem("connection failed or returned an unexpected response") from None

    def patient_links(self, job_id):
        """Source patient id to chart id for a committed import, new and attached charts alike."""
        page = self.call("GET", f"/api/v1/migrations/{uuid.UUID(job_id)}/patient-links")
        return {link["source_patient_id"]: str(uuid.UUID(link["patient_id"])) for link in page["items"]}


class TextOnly(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head", "title"):
            self.hidden += 1
        elif tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head", "title"):
            self.hidden = max(0, self.hidden - 1)
        elif tag in ("p", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def html_to_text(raw):
    parser = TextOnly()
    parser.feed(raw.decode("utf-8", "replace"))
    lines = [clean(line) for line in "".join(parser.parts).split("\n")]
    out = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    text = "".join(ch for ch in "\n".join(out).strip() if ch in "\n\t" or ord(ch) >= 32 and ord(ch) != 127)
    encoded = (text + "\n").encode()
    if not text or len(encoded) > MAX_TEXT_DOCUMENT_BYTES:
        raise ImportProblem("converted text is empty or exceeds the text document limit")
    return encoded


def to_jpeg(raw, suffix, work):
    """Re-encode with the macOS image tool inside the private directory only."""
    with tempfile.TemporaryDirectory(dir=work) as folder:
        os.chmod(folder, 0o700)
        source, target = pathlib.Path(folder) / ("source" + suffix), pathlib.Path(folder) / "converted.jpg"
        source.write_bytes(raw)
        try:
            subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", str(source), "--out", str(target)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        except (OSError, subprocess.SubprocessError):
            raise ImportProblem("image conversion needs the macOS sips tool") from None
        converted = target.read_bytes()
    if sniff(converted) != ("image/jpeg", True) or len(converted) > MAX_DOCUMENT_BYTES:
        raise ImportProblem("converted image is not an acceptable JPEG")
    return converted


def prepare_upload(plan, raw, work):
    name = pathlib.PurePosixPath(plan["member"]).name
    stem = pathlib.PurePosixPath(name).stem
    if plan["conversion"] == "html_to_text":
        raw, name = html_to_text(raw), stem + ".txt"
    elif plan["conversion"] in ("heic_to_jpeg", "reencode_jpeg"):
        raw, name = to_jpeg(raw, pathlib.PurePosixPath(name).suffix or ".img", work), stem + ".jpg"
    elif plan["conversion"] != "none":
        raise ImportProblem(plan.get("reason") or "file type is not accepted")
    name = "".join(ch for ch in name if ch not in "/\\" and ord(ch) >= 32 and ord(ch) != 127)[:255] or "file"
    title = clean(re.sub(r"[_]+", " ", re.sub(r"_?[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}.*$", "", stem)))[:200] or "Imported file"
    note = "Imported from the previous record system." + ("" if plan["conversion"] == "none" else f" Converted for storage ({plan['conversion'].replace('_', ' ')}); original SHA-256 {plan['sha256']}.")
    return {"request_id": plan["request_id"], "filename": name, "content_type": plan["upload_type"],
            "content_base64": base64.b64encode(raw).decode(), "reason": "Imported from the previous record system",
            "content": {"title": title, "category": plan["category"], "document_date": None, "visit_id": None, "notes": note, "status": "active"}}


def attach(export_dir, work, api, *, job_id=None, dry_run=False, only_label=None):
    plans = json.loads((work / "attachments.json").read_text(encoding="utf-8"))
    charts = {} if dry_run else api.patient_links(job_id)
    outcome, log = collections.Counter(), []
    for plan in plans:
        if only_label and plan["label"] != only_label:
            continue
        result = {"label": plan["label"], "sha256": plan.get("sha256"), "request_id": plan.get("request_id")}
        try:
            if not plan.get("upload_type"):
                raise ImportProblem(plan.get("reason") or "file type is not accepted")
            body = prepare_upload(plan, Archive(pathlib.Path(export_dir) / plan["archive"]).read(plan["member"], MAX_FILE_BYTES), work)
            if dry_run:
                result["status"] = "ready"
            else:
                patient = charts.get(plan["patient_source_id"])
                if not patient:
                    raise ImportProblem("patient is not imported yet")
                result["document_id"] = api.call("POST", f"/api/v1/patients/{uuid.UUID(patient)}/documents", body)["id"]
                result["status"] = "uploaded"
        except ImportProblem as error:
            result.update(status="skipped", reason=str(error))
        outcome[result["status"] + (": " + result["reason"] if result.get("reason") else "")] += 1
        log.append(result)
    write_private(work / "attachment-results.json", dump(log))
    return dict(outcome)


# --- files folder for the Data import page --------------------------------------------------

FILES_MANIFEST = "files-manifest.json"
FILE_EXTENSIONS = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "text/plain": ".txt"}


def prepare_files(export_dir, work, out, *, only_label=None):
    """Write converted, upload-ready files and their manifest for the browser upload."""
    plans = json.loads((work / "attachments.json").read_text(encoding="utf-8"))
    source_instance = json.loads((work / "batches" / "manifest.json").read_text(encoding="utf-8"))["source_instance"]
    outcome, entries = collections.Counter(), []
    for plan in plans:
        if only_label and plan["label"] != only_label:
            continue
        try:
            if not plan.get("upload_type"):
                raise ImportProblem(plan.get("reason") or "file type is not accepted")
            expected = str(uuid.uuid5(UUID_NAMESPACE, f"{source_instance}|{plan['patient_source_id']}|{plan['sha256']}"))
            if plan.get("request_id") != expected:
                raise ImportProblem("upload plan does not belong to this import; run package again")
            body = prepare_upload(plan, Archive(pathlib.Path(export_dir) / plan["archive"]).read(plan["member"], MAX_FILE_BYTES), work)
            raw = base64.b64decode(body["content_base64"])
            limit = MAX_TEXT_DOCUMENT_BYTES if body["content_type"] == "text/plain" else MAX_DOCUMENT_BYTES
            if not raw or len(raw) > limit or body["content_type"] not in FILE_EXTENSIONS:
                raise ImportProblem("file is empty, too large or not an accepted type")
            if body["content_type"] != "text/plain" and sniff(raw) != (body["content_type"], True):
                raise ImportProblem("file content does not match its type")
            digest = hashlib.sha256(raw).hexdigest()
            name = digest + FILE_EXTENSIONS[body["content_type"]]
            target = out / name
            if not target.exists() or target.stat().st_size != len(raw):
                fd, temporary = tempfile.mkstemp(prefix=".ccda-", dir=out)
                with os.fdopen(fd, "wb") as output:
                    output.write(raw)
                os.chmod(temporary, 0o600)
                os.replace(temporary, target)
            entries.append({"file": name, "source_patient_id": plan["patient_source_id"],
                            "original_name": pathlib.PurePosixPath(plan["member"]).name, "upload_name": body["filename"],
                            "content_type": body["content_type"], "category": plan["category"], "size": len(raw), "sha256": digest,
                            "request_id": plan["request_id"], "title": body["content"]["title"], "notes": body["content"]["notes"]})
            outcome["ready"] += 1
        except ImportProblem as error:
            outcome["skipped: " + str(error)] += 1
    write_private(out / FILES_MANIFEST, dump({"format": "suncharts-import-files/1", "source_instance": source_instance, "files": entries}))
    return dict(outcome)


# --- command line ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("package", help="parse the export and write the staged import into the private work directory")
    pack.add_argument("--export-dir", required=True)
    pack.add_argument("--work-dir", required=True, help="private directory (mode 0700) for every output")
    pack.add_argument("--source-instance", required=True, help="stable ID for the previous record system; keep it across runs")
    pack.add_argument("--source-revision", required=True, help="operator's reference for this export")
    pack.add_argument("--mrn-prefix", default="IM")
    pack.add_argument("--keep-test-patients", action="store_true")
    pack.add_argument("--exclude", action="append", default=[], metavar="LABEL", help="leave out a patient by index label, e.g. P07")
    pack.add_argument("--confirm-source-read-only", action="store_true", required=True)
    send = commands.add_parser("attach", help="upload planned files as patient documents after the import is committed")
    send.add_argument("--export-dir", required=True)
    send.add_argument("--work-dir", required=True)
    send.add_argument("--api-base", help="https://... base of the SunCharts EHR; token is read from SUNCHARTS_ACCESS_TOKEN")
    send.add_argument("--job-id", help="ID of the committed import job; each patient's chart is looked up through it")
    send.add_argument("--only", metavar="LABEL")
    send.add_argument("--dry-run", action="store_true", help="convert and validate without sending anything")
    folder = commands.add_parser("files", help="write upload-ready files and files-manifest.json for the Data import page")
    folder.add_argument("--export-dir", required=True)
    folder.add_argument("--work-dir", required=True)
    folder.add_argument("--out-dir", required=True, help="private directory (mode 0700) the owner picks on the Data import page")
    folder.add_argument("--only", metavar="LABEL")
    args = parser.parse_args(argv)
    try:
        work = private_directory(args.work_dir, args.export_dir)
        if args.command == "package":
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", args.source_instance) or not args.source_revision.strip() or len(args.source_revision) > 200:
                raise ImportProblem("source instance must be a plain identifier and the revision at most 200 characters")
            salt = None
            if (work / "match-hashes.json").exists():
                salt = json.loads((work / "match-hashes.json").read_text(encoding="utf-8")).get("salt")
            packages, private, report = collect(args.export_dir, args.source_instance, args.source_revision, mrn_prefix=args.mrn_prefix,
                                                keep_test=args.keep_test_patients, exclude_labels=set(args.exclude), salt=salt)
            write_outputs(work, packages, private, report, args.source_instance)
        elif args.command == "files":
            out = private_directory(args.out_dir, args.export_dir)
            if out == work:
                raise ImportProblem("the files folder must be separate from the work directory")
            report = {"files": prepare_files(args.export_dir, work, out, only_label=args.only)}
        else:
            if not args.dry_run and not (args.api_base and args.job_id):
                raise ImportProblem("--api-base and --job-id are required unless --dry-run is given")
            api = None if args.dry_run else Api(args.api_base, os.environ.get("SUNCHARTS_ACCESS_TOKEN"))
            report = {"attachments": attach(args.export_dir, work, api, job_id=args.job_id, dry_run=args.dry_run, only_label=args.only)}
    except (ImportProblem, OSError, ValueError) as error:
        parser.exit(1, f"Import preparation failed: {error if isinstance(error, ImportProblem) else type(error).__name__}\n")
    print(json.dumps(report, indent=1, sort_keys=True))  # counts only; never patient data


if __name__ == "__main__":
    main()
