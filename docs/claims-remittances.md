# Claims and ERA remittances

This native revenue-cycle increment extends posted billing accounts. It provides
local claim packets, recorded external lifecycle evidence, bounded ERA staging,
explicit matching, selected contractual credits, atomic ledger posting and
append-only reversal. It is a development preview, not complete native workflow support,
a clearinghouse, an X12 certification or an ONC certification. For the current
cross-domain assessment, see the [capability roadmap](roadmap.md).

## Staff workflow

1. In a patient chart, review insurance and post a charge account. Open its detail
   and choose **Prepare claim**. Posting requires the existing signed-visit or
   explicitly reconciled source-account boundary.
2. Review provider identity, valid-check-digit NPIs, Tax ID, subscriber birth date,
   addresses, place of service, ICD-10-CM diagnoses and each line's 1-based diagnosis
   pointers. Drafts may be incomplete. **Ready** requires the local preflight to pass
   and freezes the packet, including patient, charge, coverage and payer snapshots.
   These checks do not establish payer acceptance or clinical coding correctness.
3. Export the JSON packet if needed. It is explicitly **not an X12 837**, and export
   leaves status unchanged. Record external submission, acceptance or rejection only
   with an evidence reference and a nonfuture event date. Acceptance requires a
   payer claim control number. The subsequent [clearinghouse increment](x12-clearinghouse.md) adds 837P files,
   manual handoff and bounded acknowledgment review; the JSON packet endpoint
   remains available independently.
4. Rejected/adjudicated claims with a payer control can have a linked replacement
   or void-request draft. A claim rejected before a payer control number exists can instead have a linked
   corrected original resubmission. Original and child packets remain separate. Only one
   draft/ready/submitted/accepted claim may occupy an account. A void request is
   evidence preparation only; it cannot post an ERA or reverse an accounting entry.
5. **Claims & remittances → Import remittance** accepts a file or pasted original
   835 text, or a normalized JSON document. Select the exact native payer. Every
   document is staged; import itself cannot change a balance. Multi-transaction
   originals use the [ERA batch workflow](era-files-corrections.md), which preserves
   envelope order and requires whole-file review/post/undo.
6. Review every row's claim, patient, control identifiers, payer claim control,
   charge total and current account balance. Inspect the selected native claim to
   capture its current claim/account versions. A historical patient control alias
   must have been explicitly reviewed in the draft before release. Select the CO
   adjustments that should become contractual credits; they are never preselected
   for a new match. PR remains patient-responsibility evidence, never a write-off.
7. Save the matches and then post with an attributed reason. Posting rechecks all
   amounts, identities, lifecycles, versions and remaining balances under the same
   tenant billing lock as manual ledger writes. Payment, selected CO credits,
   account revision, claim adjudication, ERA revision and audits commit together.
8. Reverse an entire posted ERA with a reason. Offsetting entries append to the
   ledger; original document, postings and revisions remain. The claim returns to
   its pre-posting state with a new version. Downstream replacement activity or a
   changed claim blocks reversal for independent reconciliation. ERA-created entries
   cannot be individually reversed through the manual ledger endpoint.

## Supported review profile and limits

Amounts use integer USD cents throughout; decimal X12 amounts are parsed exactly.
The individual-remittance endpoint accepts one 835 transaction: 0–30 claims
(at least one claim or PLB pair), at most 100 CAS adjustments and 100 service lines
per claim. Multi-transaction originals use the batch API: up to 20 transactions
and 4,000 segments across multiple groups/interchanges, with ordered atomic
review/post/undo. The original-file limit is 48,000 ASCII bytes; JSON requests
also remain subject to the server's 64 KiB body limit. Full ISA/GS envelopes must
have matching controls/counts; unwrapped ST/SE fixtures are accepted. See the
[batch profile](era-files-corrections.md). Envelope checks are not full TR3 validation.

ST/SE, BPR, TRN, payer N1, CLP, CAS, SVC, patient NM1 and service REF evidence is
parsed. CLP status 1/2/3/4/19/20/21 with nonnegative bounded amounts and exact-original signed CLP22 reversals can be reviewed; all
claims must balance charge = paid + CAS, PR CAS must equal CLP patient responsibility,
service totals and service CAS must balance when present, and the payer payment
must equal claim payments minus signed PLB amounts. Payer code and both claim controls must match
reviewed native evidence. Ordinary duplicate payments/matches remain blocked.
Repeated rows for a claim require the explicit source-ordered reversal/correction
plan, exact source row links and valid active posting head; a positive correction
must follow its exact reversal. These rows may occur within a transaction or
across the ordered transactions of a batch. Duplicate payer/trace receipts across
independent receipts and reused source identities are blocked; distinct transactions
in one batch may retain the same EFT trace. Request IDs make identical creation
retries idempotent. All post/reverse writes require If-Match.

Unreviewed provider adjustments, source-ambiguous claim reversals, unsupported
status, unmatched claims, unbalanced totals and inconsistent payer identity stay
unpostable. Provider settlement and exact CLP22 workflows are described below. Unsupported segments are retained in original text and
flagged rather than silently ignored for posting; administrative address/contact,
date and remark segments remain only as original text. Multi-transaction files and
ordered correction chains are implemented in the [batch profile](era-files-corrections.md).
Secondary-payer coordination, payer-specific edits, bank refunds, attachments,
broader institutional/dental claim generation, 276/277 claim status, EFT bank
settlement and provider-account acceptance remain future work. Bounded 837P,
999/277CA and provider transports are documented separately. No bank/card transfer occurs. Full licensed terminology validation,
code-system versions and payer companion guides remain future validation work.

CAS handling follows the separation documented by
[CMS payment/remittance guidance](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice):
CO identifies provider contractual responsibility; PR identifies patient
responsibility. This implementation requires staff review before any CO credit.
It does not decide whether a patient may legally be billed or determine benefits.

## Legacy migration mapping

Run the existing patient/financial source exporters first, using a single frozen
snapshot. Then append the claims CSV and optional explicitly selected ERA files:

```sh
python3 scripts/export_legacy_claims.py \
  --base-package /private/export/financial-package.json \
  --ehi-dir /private/export/ehi \
  --source-revision frozen-snapshot-id \
  --era-documents /private/export/era-files.json \
  --confirm-same-snapshot --out /private/export/claims-package.json
```

`era-files.json` is an array with `source_id`, `payer_source_id` (for example
`insurance_companies/7`) and the explicit local `path` of each original 835 file.
Source process-file paths are never followed automatically. The export preserves
raw document bytes as text; native import performs bounded parsing and review.
The package contains sensitive source evidence and must remain private.

| Source evidence | Preserved mapping | Native activation |
| --- | --- | --- |
| claims.csv patient_id + encounter_id + version | `claim`, source identity `claims/{patient}/{encounter}/{version}`; original row and exact source billing/payer links | Patient-scoped source-history review → select posted insured account → new draft |
| payer_id | Explicit source payer reference; 0 remains source self-pay evidence | No native payer inferred; native insured claim requires reviewed payer |
| status, bill_process, timestamps, target, process_file, submitted_claim | Original strings, including the submitted packet | No automatic submitted/accepted state, transport or control alias |
| Explicit original ERA file + payer mapping | Global `remittance` source with original_text and source payer reference | Choose native payer → stage → exact claim matching → independently reviewed posting |
| Prior ar_activity / ar_session | Existing transaction history | Reconcile prior receipts before claim activation; no duplicate payment inferred |

Source schemas must be pinned and reviewed before export.
Missing patient/billing/payer relationships, duplicate source claim versions and
oversized documents fail the exporter. Source claim/ERA records remain read-only.
An imported historical remittance is never automatically posted to a reconstructed
balance; staff must resolve prior AR to avoid duplicating original receipts.

## API and access

The Apache-2.0 API contract documents claim and remittance routes under
`/api/v1/billing`, claim creation under the patient's posted account, patient-scoped
`claim-mapping`, and `remittance-sources`. OAuth clients require explicit
`billing.read` / `billing.write`; clinical scope alone does not authorize these
routes. Staff may read; owner, clinician and front desk may mutate. Patient and
read-only identities cannot mutate. Tenant identity always comes from the session
or token. Reads, mapping inspection, packet exports and writes are audited.

Migration 0009 adds separate claim/ERA tables and immutable revision/posting
records. Every mutation shares the existing tenant billing transaction lock;
posted charge snapshots and all source evidence remain independent.

Native 837P generation and clearinghouse file workflows are now implemented for
the bounded profile in [x12-clearinghouse.md](x12-clearinghouse.md). The broader
837/acknowledgment/transport gaps above remain subject to that narrower coverage.

## Claim.MD ERA automation and source system handover

Claim.MD ERA discovery and original retrieval now feed the durable provider inbox.
The web Revenue cycle and Clearinghouse views include independent ERA polling,
owner controls, automatic staging outcomes, holds and history. Automatic staging
is optional, disabled initially, and only proposes exact native matches. Staff
review CO credits and current balances before explicit reconciliation/posting;
automation never posts money. See [adapter contract](clearinghouse-adapters.md#claimmd-era-retrieval-and-staging-api-090).

Optional fields in each `--era-documents` manifest entry:

```json
{"source_id":"era/SYN-001","payer_source_id":"insurance_companies/7","path":"/private/synthetic.835","provider":"claim_md","provider_report_id":"23853671"}
```

The exporter retains the provider/ERA identity, original bytes, and source payer
reference while rejecting unknown manifest fields such as credentials/cursors.
The native web source mapping displays these identities. Historical mappings
continue through explicit native payer selection, original parsing, exact claim
matching and reviewed posting. They cannot activate a transport connection,
automatic staging or a live cursor. Reconcile preexisting source system payments before
posting; importing source evidence does not import or authorize a ledger balance.
Duplicate payer/trace protection applies across manual and automated staging.

Migration 0014 adds separate ERA discovery state, immutable feed history and
immutable report outcomes. Existing claim, ERA, account, posting and reversal
invariants remain in force. No production migration or external acceptance is
claimed.

## Provider settlements and claim recovery (API 0.10.0)

The 835 model now retains every PLB pair as provider ID, fiscal date, reason,
reference and exact signed cents. A document may have provider adjustments without
claim rows. Reconciliation requires `BPR = sum(CLP paid) - sum(PLB)`. Positive
PLB reduces settlement cash; negative PLB increases it. Up to six pairs per
segment and 120 pairs per document are supported, using the ISA component
separator when present. Original text remains immutable. Ordinary claim statuses
19–21 and CAS OA/PI/CR now join the existing statuses and CO/PR evidence; only
explicitly selected CO adjustments become patient-account credits.

In remittance review, the provider panel displays the settlement equation,
provider/fiscal identities, code/reference, signed amount and cash effect. Staff
confirm every PLB pair and supply a reason before saving provider review; the
packet remains staged until claim matching is saved. Owner/clinician/front-desk
billing write roles use current remittance If-Match. The classification is tied
to the source code/sign: FB is forward balance, positive WO is recoupment,
negative/zero WO is an overpayment offset, 72 is refund, L6 is interest, and other
codes require an explicit `other` review. This classification is a local workflow
rule, not a substitute for payer companion-guide interpretation.

An optional original remittance link must identify a posted settlement for the
same payer and provider, with an exact trace or payer claim-control reference.
Unallocated adjustments can remain provider-level evidence. Posting appends a
separate immutable provider settlement entry for each pair. It never creates a
patient charge or applies a second reversal to a patient's account. Positive WO
opens a follow-up case with versioned dispute/acknowledge/close/reopen evidence.
These actions record local follow-up; they do not send a payer appeal, move money,
or establish patient liability. FB creates no collected-recoupment case.
Reversing the remittance appends opposite provider cash entries and voids its
cases and history atomically with the existing claim/account reversal.

CLP22 requires negative original claim, CAS and service amounts. Staff select the
exact posted original remittance and zero-based original claim row (the web UI
shows 1-based rows), plus current claim/account versions. The source must still
be posted and resolve to the active posting head for that native claim/payer/account,
with no downstream replacement or active dependent recovery. A previously undone
recovery does not permanently disqualify the restored original. The reversal must
mirror its original control,
payer control, charged/paid/PR values, CAS reasons/scope and service lines. No new
CO write-off may be selected. Posting appends reversals of the actual original
payment and selected credits, restores the prior claim lifecycle, and records an
immutable recovery link. A negative WO/FB offset can balance the initial reversal
without treating a later positive WO collection as another patient-account debit.
The recovery remittance can itself be reversed by offsetting those reversal
entries and restoring its saved claim state. An active dependent recovery blocks
reversal of its original settlement.

source system export now preserves `settlement_mapping.provider_adjustments` with
signed source amount text and stable pair indexes, and `claim_reversals` with
source control identities and row indexes. Optional manifest
`source_ar_session_id` and `source_ar_activity_ids` must identify transaction
sources already present in the same frozen financial package. The web source
mapping shows these references and the original ERA. They do not activate cases,
post an old payment a second time, or infer a native original-payment match.
Reconcile already-migrated AR activity before native posting.

Example source manifest entry:

```json
{"source_id":"era/SYN-RECOVERY","payer_source_id":"insurance_companies/7","path":"/private/recovery.835","provider":"claim_md","provider_report_id":"23853671","source_ar_session_id":"ar_session/8","source_ar_activity_ids":["ar_activity/1/55/1"]}
```

Migrations 0015–0016 add immutable provider reviews/entries, recovery links,
recoupment case history and immutable case source identity. API routes expose
`GET/PUT /api/v1/billing/remittances/{id}/provider-adjustments`,
`GET /api/v1/billing/recoupments` (up to 100 cases), and versioned
`POST /api/v1/billing/recoupments/{id}/actions`.

This is an expanded 835 implementation, not full X221A1/TR3 certification or full
native workflow support. The current individual endpoint retains a single-transaction
boundary; [API 0.11.0 batches](era-files-corrections.md) support multiple transaction
sets/interchanges and explicit repeated reversal/correction chains. Both remain
bounded to USD, nonnegative credit BPR and the documented file/row limits. Debit
settlements, supplemental AMT/QTY/TS2/TS3/MIA/MOA interpretation and partial or
source-ambiguous recoveries remain held for independent reconciliation. Repeated
ordinary payments without an explicit valid correction lifecycle remain blocked.
Patient balances are not automatically transferred to patient liability after recoupment.

Protocol references checked October 24, 2026:
[CMS recoupment reporting](https://www.cms.gov/Regulations-and-Guidance/Guidance/Transmittals/Downloads/R906OTN.pdf),
[X12 recovery interpretation](https://x12.org/resources/requests-for-interpretation/rfi-1976-overpayment-recovery),
[UnitedHealthcare provider-level adjustment guide](https://www.uhcprovider.com/content/dam/provider/docs/public/resources/edi/EDI-835-Provider-Level-Adjustments.pdf).
These references inform the separation of claim reversal, provider adjustment and
collection. No payer-owned acceptance or production-data validation is claimed.

API 0.11.0 supports [multi-transaction files and ordered correction chains](era-files-corrections.md), including repeated correction cycles and atomic reverse-order file undo. Broader payer-specific/TR3 conformance and live-provider acceptance remain pending.
