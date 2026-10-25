# Native billing and insurance

This milestone adds local insurance administration and encounter-linked accounting
in the standalone EHR web UI. This document describes the account/coverage
boundary; subsequent increments add bounded claim generation, transport and
remittance workflows linked below. Electronic eligibility and money movement
remain unsupported. It is a bounded synthetic development preview, not a production revenue-cycle system.

## Web workflow

**Billing & insurance** in the workspace navigation provides a filterable,
UUID-cursor-paginated worklist (100 accounts per page), owner-managed payer
directory and review of imported payer records. The patient chart's **Billing &
insurance** section contains primary/secondary/tertiary coverage, policy history,
charge accounts, draft editing, local posting/voiding, manual payment and credit/
debit recording, reversals and attributed account history. A worklist account
opens the correct patient and chart section.

Coverage records include payer, member/group/plan, subscriber name/date of birth
and relationship, inclusive effective/end dates, recorded copay and manual
verification status. Overlapping active policies at the same priority are rejected;
ending/reprioritizing a policy requires an explicit versioned edit. Empty coverage
never asserts that a patient is uninsured. Manual verification never asserts an
X12 eligibility response or guarantees payment.

A new native account links to a patient visit. A reviewed historical billing
source can instead create a draft without fabricating a native encounter. Charges
record supplied code system/code, description, modifiers, diagnosis codes, units,
and **complete line total in USD cents**. Units are informational and are not
multiplied into the already-complete line total. No terminology, fee schedule or
medical coding validation is claimed. Posting requires a signed linked native
visit, valid coverage on the service date (if selected), and an active payer.
Posting captures immutable charge and payer/policy versions. A policy edit does
not rewrite previously posted accounts.

Posted accounts accept append-only manual payment/adjustment records with date,
party, receipt/EOB reference, evidence method and reason. Payment entries reduce
balance; credit adjustments reduce it; debit adjustments increase it. Reversals
append the exact opposite effect of one original entry. Original payments and
adjustments remain visible. Credits/payments/reversals that would overpay or make
the balance negative are rejected; dependent entries must be reversed first.
Posted charges cannot be edited or voided. Drafts can be voided and remain in
history. Open balances are overall account balances, not an adjudicated split of
patient versus payer responsibility. Recording a payment does not collect one.
Do not put card/bank credentials in evidence fields.

## API and controls

The Apache-2.0 contract is `/openapi.json`; implementation is AGPL-3.0-only.
Native financial endpoints require `billing.read` / `billing.write` OAuth scopes,
separate from clinical grants, or the existing browser session. Staff may read;
owner/clinician/front-desk may update coverage/accounts; only owners manage payers.
Patient credentials cannot access these staff endpoints. A dedicated billing role
and finer field permissions remain future work. The pre-existing general source
history API retains its staff clinical-history access policy; these new scopes do
not retroactively change access to archival records imported under that policy.

All clinical queries use trusted tenant identity; patient-specific queries also
match the patient. Cross-patient visit/coverage/source references fail. Creation
uses stable request IDs and content hashes; exact retries return the same resource,
while conflicting reuse is rejected. Edits, posting and ledger writes require the
quoted current `If-Match` version. Ledger retries with the exact request return the
original entry even with the original quoted version. Every mutation, revision
and audit commits in one transaction. A tenant lock serializes writes; account
versions prevent concurrent payments from overpaying a balance. Immutable database
triggers protect ledger entries, revisions, and posted/void account content. These
are not tamper-proof against a database administrator.

USD only; positive integer charge totals, no fractional cents, 1–100 lines per
account, 1–1000 units per line, maximum 100000000 cents per line and 1000000000 cents
per account/balance. Service/activity dates cannot be future dates. One nonvoid
account per native visit, and unique source links prevent duplicate activation.
The patient workspace errors above 1000 policies/accounts or 10000 ledger entries;
payer/source-payer directories error above 1000 entries instead of silently
truncating. Archival/pagination expansion remains necessary for larger clinics.

## Legacy migration path

The existing REST exporter already preserves insurance. The new
`scripts/export_legacy_billing.py` augments a base package with same-snapshot
`insurance_companies.csv`, `insurance_data.csv`, `billing.csv`, `ar_activity.csv`
and `ar_session.csv` from an operator-controlled EHI export. All five files need
unique CSV headers, even if empty. The base must exclude financial kinds to avoid
duplicate rows (use the REST exporter's `--sections` selection). Supply
`--base-package`, `--ehi-dir`, `--source-revision`, `--out`, and
`--confirm-same-snapshot`. Output is private and atomic and refuses overwrites.
The tool makes no network calls and cannot prove the operator's source freeze.

Patient and payer relationships are checked; charge rows group by source
patient/encounter; AR activity/session linkage is preserved with original decimal
strings and signs. Fractional cents/nonfinite values, duplicate identities and
unmapped patients block the whole export. Sessions are also preserved separately
so unapplied receipts do not disappear. Multi-patient/global sessions without a
mapped patient and AR activity without its exported charge encounter require a
future explicit reconciliation export, not silent omission.

Import preserves financial records as immutable history and creates no active
coverage, posted account, payment, verified eligibility or transmitted claim.
Owners review source payers in the billing worklist; staff review source insurance
and encounter charges from **Source history** in the chart. Native payer IDs are
selected explicitly, never inferred from numeric source system IDs. Source billing
becomes a draft only. The UI leaves charge amounts and service dates for staff
verification instead of guessing fee basis or dates. Prior AR history must be
reconciled before posting or recording any local balance adjustments. Transaction
sources show original evidence and never automatically create a payment.

| Source | Native mapping / review |
| --- | --- |
| `insurance_companies.id`, `name`, payer code/contact/address fields | Immutable `insurance_company` source; owner confirms a native payer and retains source linkage |
| `insurance_data.id` / UUID, `pid`, `provider` | Source coverage identity, mapped patient and explicitly chosen native payer |
| `type`, `policy_type` | Inspect installation/version and choose native coordination priority; no unreviewed swap |
| `policy_number`, `group_number`, `plan_name` | Member/group/plan text, bounded and reviewed |
| `subscriber_fname/mname/lname`, `subscriber_DOB`, `subscriber_relationship` | Native subscriber data with explicit relationship selection; source SSN fields are not native policy requirements |
| `date`, `date_end`, `copay`, assignment/employer/benefit fields | Review inclusive native effective dates and copay cents; remaining source fields retained in history, no inferred benefit or eligibility |
| `billing.id`, `pid`, `encounter`, `user` | Original IDs/author preserved; one historical encounter charge bundle. No native signature fabricated |
| `code_type`, `code`, `code_text`, `modifier`, `units`, `justify` | Review actual billable lines and diagnosis-only rows; enter supplied code system/modifiers/diagnoses; no terminology validation |
| `fee`, `activity`, `authorized`, `billed`, processing/clearinghouse fields | Fee stays an exact source decimal string. Staff must establish line-total versus unit-fee meaning, active status and prior billing before entering cents; submission states stay historical |
| `ar_activity` patient/encounter/sequence, pay/adjustment amounts, payer type, codes and session ID | Immutable transaction history retaining signs and source relationships; staff reconciles native recording separately |
| `ar_session` payer, patient, receipt/EOB reference, check/deposit dates, totals and method | Preserve receipt/session and linked activity separately, including unapplied evidence; never infer native collection, payment allocation or remaining balance |

Inspect actual source schemas, version and customizations before any real migration.

## Remaining capability work

Native claim preparation, bounded 837P generation, delivery/acknowledgment review,
ERA/835 import and reviewed posting/reversal are implemented. Multi-transaction
835 files, PLB provider settlements and explicit ordered reversal/correction chains
extend that bounded profile. See [claims/remittances](claims-remittances.md),
[837P profile](x12-clearinghouse.md), [provider adapters](clearinghouse-adapters.md)
and [ERA file/correction scope](era-files-corrections.md). Provider-protocol fixtures
and synthetic accounting checks do not establish live payer/clearinghouse acceptance.

Remaining work includes electronic eligibility (270/271), complete denial/appeal
and resubmission workflows, secondary/tertiary claim sequencing, comprehensive
claim scrubbing, payer/provider enrollment and live acceptance, broader claim
profiles, fee schedules, patient statements/delivery, refunds/unapplied credits/
deposits, complete remittance allocation and responsibility transfer, aging/revenue
reports, attachments, financial close and bank reconciliation, payment processors,
FHIR Coverage/Claim/EOB, validated native clinical APIs and production cutover. Cutover remains explicitly disallowed by the migration API.

Use the [capability roadmap](roadmap.md) to distinguish
locally verified bounded behavior from remaining practice and production work.
