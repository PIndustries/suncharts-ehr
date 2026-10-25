# 837P generation and clearinghouse operations

This increment generates an immutable X12 005010X222A1 professional claim file
and provides a durable, audited file-handoff workflow. Delivery evidence,
technical acknowledgment and payer outcome have separate states. The current
transport is **manual_file**. No network sender, SFTP credentials, clearinghouse
account or production connection has been configured or exercised.

## Web workflow

1. An owner opens **Clearinghouse → Trading partners**. Enter reviewed ISA, GS,
   submitter, receiver and contact identifiers, test/production file usage and a
   companion-guide/enrollment reference. Profiles have attributed immutable
   revisions. Updating a profile affects future artifacts only.
2. Prepare and release a native claim through **Claims & remittances**. Charges,
   payer, coverage, patient and provider packet evidence remain frozen. Choose
   **Generate X12 837P** on the ready claim.
3. Select the current active partner and explicitly review structured addresses,
   subscriber identity, administrative sex, rendering name, taxonomy, filing
   indicator and signature/benefit/release evidence. Generation stores those
   details alongside the frozen claim and partner versions.
4. Review the generated segments and download the exact `.x12` file. Download is
   audited but does not change the claim from ready or mark delivery. The same
   artifact always has the same bytes, controls and SHA-256 digest.
5. Upload the file through the enrolled partner's approved channel outside this
   engine. Once a completed handoff is independently verified, record its receipt,
   date and reason. This atomically records delivery and changes the unchanged
   ready claim to submitted. For an ambiguous external upload outcome, reconcile
   the partner receipt before making another attempt; this engine cannot infer
   what happened in an external portal.
6. Import a reviewed 999, TA1 or 277CA file, or choose preserved legacy source
   evidence. A supported matching 999 updates the technical result. Technical
   acceptance leaves the claim submitted and payer outcome pending. Technical
   rejection changes only the unchanged submitted claim to rejected, retaining
   its prior packet; use the existing corrected-original workflow to retry.
7. Record payer acceptance/rejection separately, with the current claim version,
   external reference and date. Acceptance requires the payer claim control number.
   This action is staff-reviewed external evidence, not an authenticated payer
   message, a delivery guarantee or an assertion that a claim will be paid.
8. Cancel a prepared artifact before handoff if corrections are needed. Its file
   and events stay in history; a new artifact uses a new interchange control.
   Cancelled files cannot be downloaded, and a prepared file whose claim changed
   cannot be exported or marked delivered. Delivered artifacts are never cancelled
   or silently regenerated; rejection uses a linked new claim.

## Generated 837P profile

The first profile supports primary USD **routine office POS 11** professional
claims; self, spouse and child subscriber relationships; an organization billing
provider and individual rendering provider; reviewed five-digit CPT or letter-plus-four-digit HCPCS
service codes, up to four two-character modifiers, integer units, and ICD-10-CM
syntax/pointers. Original, replacement and void-request frequencies are emitted;
replacement/void requests include the reviewed original payer claim control.
Secondary/tertiary COB, institutional/dental, referring/ordering providers,
facility-specific cases, accident details, drug/NDC billing, authorizations,
attachments, anesthesia/time units and payer-specific situational requirements
need broader profiles. CPT category II/III and PLA codes also remain outside this
initial numeric-CPT profile. A staff attestation does not replace those missing fields
or licensed code/terminology validation.

Files include fixed-width ISA and matched IEA controls, GS/GE, ST/SE counts,
BHT, submitter/contact/receiver, hierarchical billing/subscriber/dependent loops,
payer/provider identifiers and addresses, claim/diagnosis fields, and service
lines with dates, diagnosis pointers and line controls. Amounts use exact integer
cents and existing line totals; units are not multiplied into those totals again.
Names and addresses are uppercased; diagnosis dots are removed in HI elements.
Patient/member/payer/control identifiers preserve their reviewed values. Printable
ASCII is required, and X12 delimiters and control characters are rejected within
input elements. The generated file has at most 48,000 bytes.

Control allocation is tenant scoped and serialized with existing billing writes.
The counter is never reset by partner edits or cancellation. A claim has at most
one noncancelled artifact. Request IDs provide identical generation retry safety;
changed content with the same ID is rejected. A rolled-back generation exposes no
artifact or allocated control. Generation, delivery, acknowledgment, payer events
and their audits commit atomically. Immutable payload and history triggers prevent
in-place modification. Claims generated before this increment remain supported
by the prior JSON packet/external evidence workflow.

These structural checks are **not full licensed TR3 validation or clearinghouse
certification**. Test files and partner-specific enrollment/companion-guide
validation remain required before production use. CMS describes companion guides
as supplements to the transaction implementation guides; technical and claim-level
acknowledgments are distinct parts of exchange processing. References:
[CMS companion guides](https://www.cms.gov/medicare/coding-billing/electronic-billing/medicare-fee-for-service-compainion-guides),
[CGS 837P companion guide](https://www.cgsmedicare.com/pdf/edi/837p_compguide.pdf).
No implementation-guide text or source system module source was copied into this engine.

## Acknowledgment review boundary

One ASCII transaction up to 48,000 bytes / 1,500 segments is accepted per import,
subject to the API's overall 64 KiB JSON limit. A supported 999 must have consistent
ST/SE count/control, one AK1/AK2 identifying the artifact's HC group and 837
transaction, consistent IK5/AK9 outcomes and counts for one transaction, and no
unsupported constructs. Complete ISA/GS envelopes require matching wrapper
controls/counts. This profile intentionally requires AK2 even where a partner may
omit it; such files remain for review rather than inferred acceptance. Only
unambiguous A/R outcomes can be applied automatically through the reviewed import.
Accepted-with-errors, partial groups, unexpected segments, mismatched controls,
contradictory later responses and changed claim versions remain reviewable.

TA1 is envelope evidence only. 277CA bytes are preserved for manual claim-control,
category/status and payer-control review; there is no full 277CA loop parser or
automatic per-claim status application. Original acknowledgment text, hash,
parsed review result, source link and attributed reason are immutable. Duplicate
artifact/hash and source links are blocked. A late technical response cannot
rewrite an already accepted/adjudicated claim. No eligibility, 276/277 status
transport, EFT settlement or payer decision is inferred.

## legacy source mappings

Extend a same-snapshot claim/financial package with allowlisted partner fields and
explicit original acknowledgment files:

```sh
python3 scripts/export_legacy_clearinghouse.py \
  --base-package /private/export/claims-package.json \
  --ehi-dir /private/export/ehi \
  --source-revision frozen-snapshot-id \
  --acknowledgments /private/export/ack-files.json \
  --confirm-same-snapshot --out /private/export/edi-package.json
```

`ack-files.json` contains `source_id`, `source_partner_id`, optional
`source_claim_id`, `format` (`x12_999`, `x12_ta1`, `x12_277ca`) and an explicit local
`path`. Original ASCII text, including CRLF bytes, is retained. File paths from
source process metadata are never followed automatically.

| source system evidence | Preserved source | Explicit native mapping |
| --- | --- | --- |
| x12_partners identity and nonsecret ISA/GS/submitter fields | Global `x12_partner`, `x12_partners/{id}`; allowlisted original strings | Owner reviews identifiers, contact and guide; new source form defaults to test usage |
| Claim's x12_partner_id | Exact source partner relationship added to claim evidence | Does not select an active partner or generate/send a file |
| Original 999/TA1/277CA documents | Global `edi_acknowledgment` with exact text and declared source links | Staff selects a delivered native submission and verifies controls; no inferred historical delivery |
| Source production indicator | Read-only historical value | Never silently activates production usage |
| Credentials, login fields, endpoints, transport directories | Excluded from exporter | Re-enrollment and transport integration remain separate work |

Inspect the pinned source partner schema before export.
The exporter uses an explicit allowlist, rejecting duplicate/missing partner or
claim relationships. Passwords, tokens and client credentials are not copied;
known credential fields, including legacy X12 credential names, are also rejected
by migration staging. Native profile requests reject unknown credential fields.
Source records are imported as history and cannot activate a native partner or
claim status without separate review. Existing source system integration remains intact
in the companion SunCharts repository.

## API and remaining capability

This describes the original manual handoff milestone. See [automated delivery and 277CA](automated-delivery-277ca.md) for the newer gateway worker, inbox, migration mapping and current limitations.

API contract version 0.6.0 adds `/billing/clearinghouses`, `/billing/clearinghouse-sources`,
`/billing/claims/{id}/837p` and `/billing/submissions` detail/file/actions/acknowledgments.
OAuth clients require explicit billing read/write scopes. Owner role is required
for partner changes; staff may read and owner/clinician/front desk may record
clinical billing workflow evidence. Current resource versions and attributed
reasons are required for mutations. Identity is derived from the authenticated
session/token, and every query is tenant scoped.

Migration 0010 adds partner revisions, control allocation, immutable generated
artifacts, independent delivery/technical/payer states, event history and original
acknowledgments. Actual SFTP/API transport, secure credential provisioning, receiver
identity validation, automated receipt polling, partner onboarding/certification,
837I/837D, full 277CA adjudication, COB and complete standards and clinical acceptance remain
future work. No deployment, production claim submission or external delivery
acceptance has been performed.
