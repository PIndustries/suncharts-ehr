# Legacy migration foundation

This preview preserves synthetic source history; it does not authorize production
cutover or claim complete EHI export. Plan one authoritative writer per clinic
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
[clinical-lists.md](clinical-lists.md). Other archival rows remain read-only.
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

The lab EHI converter and explicit native order/report reconciliation are described
in [orders-labs-results.md](orders-labs-results.md). This preserves source order
relationships and labels external signatures as unverified; it does not enable
external lab delivery, full EHI coverage or production cutover.

Appointment history now supports explicit staff reconciliation into native bookings,
with patient/provider/timezone/status review and a unique immutable source link.
See [scheduling.md](scheduling.md) for the complete field mapping, DST-safe proposal
utility, supported workflow and remaining calendar gaps. Recurrence and
source completion states are never executed automatically during import.

Insurance and billing now have native review workflows. The financial EHI exporter
preserves payer/coverage, encounter charge bundles and AR evidence with exact
source decimals. Import never posts balances or payments. Payer, coverage and
charge activation require explicit staff reconciliation; source charge accounts
start as drafts. See [billing-insurance.md](billing-insurance.md) for field maps,
workflow limits, financial permissions and remaining revenue-cycle work.

## Claim and remittance sources

The financial source package can be extended with `export_legacy_claims.py`.
Patient-scoped claim rows and global original ERA documents remain historical
until independently reconciled. See [claims-remittances.md](claims-remittances.md)
for exact identities, same-snapshot requirements and prevention of duplicate AR.

EDI source packages can now be extended with allowlisted nonsecret trading-partner
identifiers and original 999/TA1/277CA files. See
[x12-clearinghouse.md](x12-clearinghouse.md) for the exporter, exact relationships,
reviewed test-mode profile activation and native submission matching boundary.

API 0.11.0 now supports [multi-transaction files and ordered correction chains](era-files-corrections.md), including repeated correction cycles and atomic reverse-order file undo. The earlier single-transaction/repeated-chain exclusions describe the 0.10.0 profile. Broader payer-specific/TR3 conformance remains pending.
