#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 P Industries
"""Export a bounded, explicitly scoped source system REST snapshot for staged import.

Use the existing SunCharts /connections/{id}/rest base to retain connector
workarounds, or source system's /apis/{site}/api base. This is not full EHI export.
Never invent signature evidence, suppress failed sections, or publish a partial file.
"""
import argparse
import collections
import datetime
import json
import os
import pathlib
import tempfile
import urllib.error
import urllib.parse
import urllib.request

SECTIONS = {
    "medical_problem": ("uuid", "medical_problem"),
    "allergy": ("uuid", "allergy"),
    "medication": ("pid", "medication"),
    "appointment": ("pid", "appointment"),
    "insurance": ("pid", "insurance"),
}


class ExportError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never send a bearer token to a redirected destination.


class Source:
    def __init__(self, base, token):
        uri = urllib.parse.urlsplit(base)
        if (uri.scheme != "https" and not (uri.scheme == "http" and uri.hostname in {"localhost", "127.0.0.1", "::1"})) or uri.username or uri.password or uri.query or uri.fragment:
            raise ExportError("Use an HTTPS API base, or loopback HTTP for synthetic testing")
        if not token:
            raise ExportError("LEGACY_ACCESS_TOKEN must be set in the environment")
        self.base = base.rstrip("/")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)

    def rows(self, path, empty_404=False):
        req = urllib.request.Request(self.base + "/" + path, headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            raw = error.read(65536)
            if error.code == 404 and not raw.strip() and empty_404:
                return []
            raise ExportError(f"Source request failed (HTTP {error.code}); no package written") from None
        except urllib.error.URLError:
            raise ExportError("Source connection failed; no package written") from None
        if len(raw) > 16 * 1024 * 1024:
            raise ExportError("Source response exceeds the bounded exporter limit")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ExportError("Source returned invalid JSON; no package written") from None
        if isinstance(value, dict):
            if value.get("validationErrors") or value.get("internalErrors"):
                raise ExportError("Source reported record errors; no package written")
            if value.get("next") or value.get("links") or value.get("link"):
                raise ExportError("Paginated source response requires a pagination-aware exporter; no package written")
            value = value.get("data", value)
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
            raise ExportError("Unexpected source record shape")
        return value


def first(row, *keys):
    for key in keys:
        if row.get(key) is not None and str(row[key]).strip():
            return str(row[key]).strip()
    raise ExportError("A source identifier or required demographic field is missing")


def collect(source, source_instance, revision, sections):
    items, identities = [], set()

    def add(kind, key, patient, data, raw):
        identity = (kind, key)
        if identity in identities:
            raise ExportError("Duplicate source identifiers require review")
        identities.add(identity)
        items.append({"kind": kind, "source_id": key, "patient_source_id": patient, "data": data, "source_data": raw})

    for row in source.rows("patient"):
        puuid, pid = first(row, "uuid", "puuid"), first(row, "pid", "id")
        birth = first(row, "DOB", "dob", "birth_date")[:10]
        try:
            datetime.date.fromisoformat(birth)
        except ValueError:
            raise ExportError("A source birth date requires identity review") from None
        add("patient", puuid, None, {"mrn": first(row, "pubpid", "external_id", "pid"), "given_name": first(row, "fname", "first_name"), "family_name": first(row, "lname", "last_name"), "birth_date": birth}, row)
        quote = lambda value: urllib.parse.quote(value, safe="")
        for kind in sections:
            selector, resource = SECTIONS[kind]
            patient_key = puuid if selector == "uuid" else pid
            for record in source.rows(f"patient/{quote(patient_key)}/{resource}", empty_404=True):
                key = first(record, "uuid", "id", "eid", "pc_eid")
                add(kind, puuid + "/" + key, puuid, record, record)
        for encounter in source.rows(f"patient/{quote(puuid)}/encounter", empty_404=True):
            eid = first(encounter, "encounter", "eid", "id", "encounter_id")
            add("encounter", puuid + "/" + eid, puuid, encounter, encounter)
            for kind in ["vital", "soap_note"]:
                for record in source.rows(f"patient/{quote(pid)}/encounter/{quote(eid)}/{kind}", empty_404=True):
                    key = first(record, "id", "uuid", "vid", "form_id")
                    add(kind, puuid + "/" + eid + "/" + key, puuid, record, record)
    counts = dict(sorted(collections.Counter(item["kind"] for item in items).items()))
    counts.setdefault("patient", 0)
    return {"manifest": {"source_instance": source_instance, "source_revision": revision, "expected_counts": counts,
        "consistency": "read_only_export", "limitations": [
            "Operator asserted a read-only source; server-side freeze was not independently verified.",
            "Scoped REST export only: patients, selected lists, encounters, vitals and SOAP notes.",
            "Document bytes, signatures, labs, prescribing networks, claims, messages and other unselected domains require additional exports and reconciliation.",
            "Patient demographics map directly; problems, allergies and medications require explicit clinician reconciliation from preserved history. Other domains remain archival."
        ]}, "items": items}


def write_package(package, destination):
    path = pathlib.Path(destination)
    fd, temporary = tempfile.mkstemp(prefix=".legacy-export-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(package, output, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)  # Atomic publication; refuse to overwrite an existing export.
    finally:
        os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--source-instance", required=True, help="Stable ID for the source installation; keep it across snapshots")
    parser.add_argument("--source-revision", required=True, help="Operator's snapshot/watermark reference")
    parser.add_argument("--out", required=True)
    parser.add_argument("--sections", nargs="*", choices=list(SECTIONS), default=list(SECTIONS))
    parser.add_argument("--confirm-source-read-only", action="store_true", required=True)
    args = parser.parse_args()
    try:
        package = collect(Source(args.api_base, os.environ.get("LEGACY_ACCESS_TOKEN")), args.source_instance, args.source_revision, args.sections)
        write_package(package, args.out)
    except (ExportError, OSError) as error:
        parser.exit(1, f"Export failed: {error}\n")
    print(json.dumps({"record_count": len(package["items"]), "counts": package["manifest"]["expected_counts"]}))


if __name__ == "__main__":
    main()
