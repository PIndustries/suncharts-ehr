# Migration

Imports preserve source history. Production cutover is disabled; complete EHI
export is not implemented. Plan one authoritative writer per clinic
throughout transition.

## Import path

Frozen legacy snapshot → staged SunCharts records → reconciled history import →
clinical validation → separately approved cutover. OAuth linking does not migrate
data. Hosting moves, full backup/restore and production cutover automation are
separate operational work.

## Export and import

`scripts/export_legacy.py --help` describes the initial exporter. Set the linked
bearer in `LEGACY_ACCESS_TOKEN` privately, use HTTPS, and provide `--api-base`, a
stable `--source-instance`, a source snapshot/revision watermark, `--out` and
`--confirm-source-read-only`. Prefer the existing SunCharts REST proxy to benefit
from its source system compatibility handling. The operator must freeze source writes;
the exporter cannot independently prove a consistent multi-endpoint snapshot.
Do not pass tokens on the command line or commit exports.

Current exporter domains: patients, encounters, vitals, SOAP, medical problems,
allergies, medications, appointments and insurance. Source rows and author fields
are preserved. Unsupported pagination, invalid identities and failed requests stop
export. Output is written atomically with mode 0600, never overwriting a file.
It does not fetch document bytes, complete labs, claims, messages, eRx-network state
or all source system modules. Every package declares its limitations explicitly.

The owner uploads the package under **Data migration**. The GUI creates a job,
stages batches (up to 50 records within 64KiB), and reconciles declared counts,
patient references, MRN collisions and external identities. It shows the report
before a separate **Import reconciled history** action. The commit requires the
current SHA-256 digest of the manifest and ordered records. Changed source data
within a snapshot or against an existing source mapping blocks import; exact
retries and re-imports are idempotent. Source updates need a future explicit
reconciliation/correction workflow, not blind overwrite.

Patients become native demographics. Other domains are immutable source history,
with `signature_origin=external_unverified` and
`release_policy=staff_only_pending_review`. The chart exposes these records to
staff separately from newly authored notes. No source note becomes a newly signed
native encounter; no history is automatically released to the patient portal.
Problems/allergies/medications can now be explicitly reconciled into native list
entries by a clinician, with immutable links to source history; see
[clinical workflow](clinical.md). Other archival rows remain read-only.
Directory entries can be preserved but are not native identity accounts. Recognizing
a kind name in the preservation schema does not implement that domain's workflow.

Maximum 100000 records per job; staged packages remain PHI and need deployment-level
encryption, retention and storage controls before real use. Known credential fields
are rejected recursively; this is not a comprehensive secret scanner or redaction
engine. Do not include user password/token exports.

## C-CDA archives from another record system

`scripts/import_ccda.py package` reads a folder of per-patient archives (a `.zip`
or an unpacked folder holding one or more C-CDA `ClinicalDocument` files plus
attachments) and writes a package for the owner's **Data import** page, the same package split
into `batches/` for the API, and a counts-only report. It never changes or
extracts the export. Every output except the printed report contains patient data
and is written with mode 0600 into a work directory that must be mode 0700 and
outside the repository. Run it with `python3 -I`.

| C-CDA section | Imported as |
|---|---|
| Record target | `patient` (name, birth date, generated `IM-` MRN); other demographics as `form` |
| Problems, Medications, Allergies | `medical_problem`, `medication`, `allergy` with the fields clinician reconciliation reads |
| Encounters, Clinical Notes, Vital Signs | `encounter`, `soap_note`, `vital` |
| Immunizations, Results, Procedures | `immunization`, `lab_result`, `procedure` |
| Insurance Providers, Reason for Referral | `insurance`, `referral` |
| Every other section with content | `form`: attributed read-only narrative with its coded entries |

Source codes (SNOMED CT, RxNorm, NDC, ICD-10-CM, LOINC, CVX, CPT) are kept on each
record; the source entry is preserved in `source_data`. Sections holding only a
"no information" placeholder are skipped, and "no known allergies" assertions are
kept as narrative rather than as list entries. Social Security and driver licence
numbers are dropped. Source identifiers come from the document, so a repeated run
produces identical records; a later document of the same patient supersedes an
earlier version of the same entry. Likely test records are excluded by name and
listed in the private index; `--keep-test-patients` and `--exclude P07` override.

Patients are matched to existing charts by source identifier only. There is no
name or birth date matching and no patient merge: a person who was already
registered by hand is imported as a second chart. Before staging, run the
generated read-only `match-query.sql` against the database; it compares salted
SHA-256 hashes of normalized family name, first given name and birth date and
returns matching hashes without names. Passing those hashes back with `--matches`
moves the matched patients into `package-held-matches.json`. With
`hash,existing_patient_id` lines the tool also writes `link-existing-patients.sql`,
which records the reviewed identity in `source_identifiers` with the record digest
the importer expects; after it runs, importing the held package attaches the
history to the existing chart and creates no patient. That link is a reviewed
operator database change, not an application feature.

`import_ccda.py attach` uploads the files in each archive to the imported patient
through the patient documents route once the import is committed, with a request
identifier derived from the file so a retry never stores a second copy. PDF, PNG
and JPEG are sent unchanged. HEIC photos and JPEG files without a proper end
marker are re-encoded to JPEG with the macOS `sips` tool; HTML is stored as plain
text. `--dry-run` converts and validates without sending anything. Uploading
needs `SUNCHARTS_ACCESS_TOKEN`, an OAuth access token with `clinical.read` and
`clinical.write` granted by an owner or clinician. Linked patients need
`--patient-map`.

Imported history cannot be removed: `historical_records` rejects updates and
deletes, a stored document can only be marked archived or entered in error, no
route deletes a patient, and there is no rollback route. Take a database backup first; restoring it is the only undo. A wrongly
created chart can only be archived. The chart lists at most 100 imported
records per patient.

## Cutover release criteria

Every job returns `cutover.allowed=false`. Required future work includes complete
source inventory/EHI and binary export, terminology and field reconciliation,
clinical review and workflow equivalence, patient matching/merge review, source
freeze verification, incremental changes, attachments, account/role mappings,
backup/restore rehearsal and a tested rollback plan. Medication lists, lab rows,
claims and messages need their actual clinical/financial interfaces, not just
archival preservation. No automatic source deletion or two-way write replication
is implemented.

## Domain tools

Run each script with `--help` for required inputs and its output contract:

| Tool | Purpose |
|---|---|
| `export_legacy.py` | Patient and core clinical history package |
| `export_legacy_labs.py` | Join order/report/result exports into the same snapshot |
| `export_legacy_billing.py` | Payer, coverage, charge and AR evidence |
| `export_legacy_claims.py` | Claim/remittance and settlement source evidence |
| `export_legacy_clearinghouse.py` | Trading partner and transport history |
| `map_legacy_appointment.py` | Prepare a reviewed nonrecurring booking proposal |
| `import_ccda.py` | Package per-patient C-CDA archives from another record system |

These tools do not migrate authentication secrets or enable live provider routes.
Domain reconciliation retains source identities, originals and explicit reviewer
attribution. Historical signatures stay unverified; historical payments do not
post to the native ledger automatically. Source-side completion states and
recurrence are not executed during import.

Review native [clinical](clinical.md), [scheduling](scheduling.md) and
[billing](billing.md) semantics before activating a mapping. Test a complete frozen
snapshot, reconcile totals and identities, rehearse rollback and obtain clinic
sign-off before any separately approved production cutover.
