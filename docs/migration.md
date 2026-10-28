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

These tools do not migrate authentication secrets or enable live provider routes.
Domain reconciliation retains source identities, originals and explicit reviewer
attribution. Historical signatures stay unverified; historical payments do not
post to the native ledger automatically. Source-side completion states and
recurrence are not executed during import.

Review native [clinical](clinical.md), [scheduling](scheduling.md) and
[billing](billing.md) semantics before activating a mapping. Test a complete frozen
snapshot, reconcile totals and identities, rehearse rollback and obtain clinic
sign-off before any separately approved production cutover.
