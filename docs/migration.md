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

The owner uploads the package under **Data import**. The page creates a job,
stages batches (up to 50 records within 64KiB), and checks declared counts,
patient references, MRN collisions and external identities. It shows the result
before a separate **Import records** action. The commit requires the
current SHA-256 digest of the manifest and ordered records. Changed source data
within a snapshot or against an existing source mapping blocks import; exact
retries and re-imports are idempotent. Source updates need a future explicit
reconciliation/correction workflow, not blind overwrite.

### Patients who already have a chart

Checking a job compares every staged patient that has no link from an earlier
import with the clinic's existing charts, using normalized names (accents folded,
letters only, lower case; first given name) and the birth date:

| Result | Meaning | Before import |
|---|---|---|
| New chart | No existing chart is similar | Nothing to decide |
| Matches a chart you already have | Exactly one chart with the same family name, first given name and birth date, and no other candidate | **Attach to this chart** is pre-selected; the owner can switch to **Create a new chart** |
| Possible match | A weaker match (family name with the same first initial, or the same first given name, on that birth date) or more than one candidate | The owner must choose a chart or a new chart |
| Already imported | An earlier import linked this patient | Records follow that link |

The decisions are stored with the job (`patient_decisions`) and recorded through
`POST /api/v1/migrations/{id}/patient-decisions`. Import is refused while any
matching patient has no decision, or when a chosen chart is no longer a candidate.
Attaching creates the patient link inside the import transaction with a
`migration.patient_attach` audit event, and every record of that patient lands on
the existing chart. The chart's name, birth date, MRN and contact details are not
changed. One chart takes the records of one imported patient. There is still no
patient merge: two charts that already exist stay separate.

A chart created by the import gets the address, phone, email, administrative sex
and language of the staged patient as its own contact details, attributed to the
import in the contact history. Values the contact profile would reject are left
out one by one. For an attached chart nothing is written; the imported records show
a **From previous system** block with **Use this** beside each field the chart
does not have yet. A filled field is never replaced.

Patients become charts. Other domains are immutable source history,
with `signature_origin=external_unverified` and
`release_policy=staff_only_pending_review`. The chart exposes these records to
staff separately from newly authored notes. No source note becomes a newly signed
native encounter; no history is automatically released to the patient portal.
Problems/allergies/medications can now be explicitly reconciled into native list
entries by a clinician, with immutable links to source history; see
[clinical workflow](clinical.md). Structured source codes (ICD-10-CM, SNOMED CT,
RxNorm, NDC) are carried into the native entry; other code systems stay as text in
its notes. **Reconcile all** on a patient's imported problems, and separately
medications, accepts the reviewed list in one action; each entry still gets its
own source link and attributed revision, entries that share a name with one
already on the list are left for individual review, and entries that are not valid
as they stand are handed back. An imported insurance record offers **Add as
coverage**, which pre-fills the coverage form for staff to confirm and save;
nothing is created automatically. Other archival rows remain read-only.
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
| Record target | `patient` (name, birth date, generated `IM-` MRN, structured contact details); everything else the previous system held as `form` |
| Problems, Medications, Allergies | `medical_problem`, `medication`, `allergy` with the fields and codes clinician reconciliation reads |
| Encounters, Clinical Notes, Vital Signs | `encounter`, `soap_note`, `vital` |
| Immunizations, Results, Procedures | `immunization`, `lab_result`, `procedure` |
| Insurance Providers, Reason for Referral | `insurance` (with the coverage form's fields), `referral` |
| Every other section with content | `form`: attributed read-only narrative with its coded entries |

Source codes (SNOMED CT, RxNorm, NDC, ICD-10-CM, LOINC, CVX, CPT) are kept on each
record; the source entry is preserved in `source_data`. Sections holding only a
"no information" placeholder are skipped, and "no known allergies" assertions are
kept as narrative rather than as list entries. Social Security and driver licence
numbers are dropped. Source identifiers come from the document, so a repeated run
produces identical records; a later document of the same patient supersedes an
earlier version of the same entry. Likely test records are excluded by name and
listed in the private index; `--keep-test-patients` and `--exclude P07` override.

Every patient in the export is staged. Whether a patient already has a chart is
decided on the Data import page as described above, so no database change is
needed before staging. The generated read-only `match-query.sql` is an optional
pre-check: it compares salted SHA-256 hashes of normalized family name, first
given name and birth date and returns matching hashes without names, which tells
you beforehand how many patients the page will ask about.

`import_ccda.py attach --job-id <job>` uploads the files in each archive through
the patient documents route once the import is committed. It asks
`GET /api/v1/migrations/{id}/patient-links` (owner only) where each source patient
went, so files reach attached charts and new charts alike without a hand-written
patient map. Each upload carries a request identifier derived from the file so a
retry never stores a second copy. PDF, PNG and JPEG are sent unchanged. HEIC photos
and JPEG files without a proper end marker are re-encoded to JPEG with the macOS
`sips` tool; HTML is stored as plain text. `--dry-run` converts and validates
without sending anything. Uploading needs `SUNCHARTS_ACCESS_TOKEN`, an OAuth access
token granted by the owner with `migration.manage`, `clinical.read` and
`clinical.write`.

The owner can add the same files from the browser instead, with no token.
`import_ccda.py files --export-dir <export> --work-dir <work> --out-dir <folder>`
writes the converted files into a private 0700 folder, each named by its SHA-256,
with a `files-manifest.json` that lists the source patient, type, category and the
same request identifier `attach` uses. On **Data import**, under an imported file,
**Add files from the previous system** takes that folder, looks up each patient's
chart through the same patient-links route and uploads one file at a time. A folder
prepared for a different import is refused. Choosing the folder again, or running
`attach` afterwards, stores nothing twice. The folder contains patient files: keep
it private and delete it when the upload is done.

Imported history cannot be removed: `historical_records` rejects updates and
deletes, a stored document can only be marked archived or entered in error, no
route deletes a patient, a patient link cannot be undone, and there is no rollback
route. Take a database backup first; restoring it is the only undo. A wrongly
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
