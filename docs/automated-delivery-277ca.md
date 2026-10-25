# Automated delivery and 277CA reconciliation

For the newer provider-native adapters and automatic inbox retrieval, see
[clearinghouse adapters](clearinghouse-adapters.md). The gateway contract below
remains supported as a separate adapter.

This development milestone adds a durable HTTPS gateway worker and a reviewed
005010X214 acknowledgment inbox. It extends the existing 837P/manual handoff,
999/TA1, claim and ERA workflows. It is partial native workflow support; it is not a
clearinghouse certification or a complete licensed X12 TR3 validator.

## Delivery contract and operation

An operator provides `ENGINE_CLEARINGHOUSE_CONFIG`, the path to a private JSON
configuration file, before starting the engine. The worker runs in the engine
process only when routes exist. Restart after changing configuration or secrets.
No destination, credential or production route is shipped with the preview.

```json
{"routes":[{
  "key":"enrolled-gateway",
  "tenant_id":"00000000-0000-4000-8000-000000000001",
  "partner_id":"00000000-0000-4000-8000-000000000003",
  "endpoint":"https://your-enrolled-gateway.example/claims",
  "usage":"T",
  "credential_env":"ENGINE_CLEARINGHOUSE_TOKEN_ENROLLED",
  "loopback_test":false
}]}
```

Credentials come from the named server environment variable. Routes bind a tenant,
partner and test/production usage. The browser sees safe route metadata only.
URLs cannot contain embedded credentials, queries or fragments; redirects and
ambient proxy use are disabled. HTTPS certificate validation remains enabled.
HTTP is permitted only for an explicit `loopback_test: true`, `usage: T` route
with numeric loopback host. That mode exists for synthetic local tests.

The endpoint implements the SunCharts gateway contract below; an arbitrary
clearinghouse API or SFTP directory is **not** compatible without an adapter.
The operator must enroll with the destination, validate its companion guide,
provide its adapter and credentials, and confirm the destination's idempotency and
receipt semantics before any production use. No partner-native adapter is included.

The worker POSTs JSON:

```json
{"submission_id":"<uuid>","payload_sha256":"<sha256>","usage":"T",
 "format":"005010X222A1","x12":"<immutable original artifact>"}
```

`Idempotency-Key` is the submission UUID, unchanged across attempts. Bearer
authentication uses the configured credential. A successful receipt must be a
bounded JSON object with exactly these fields:

```json
{"status":"received","submission_id":"<same uuid>",
 "payload_sha256":"<same sha256>","receipt_reference":"<gateway receipt>"}
```

HTTP 200/201, or a 409 with that same verified receipt, confirms receipt of the
artifact. Only then do the job, submission and claim transition atomically to
`delivered`, `delivered`, and `submitted`. This is delivery, not payer acceptance.
A gateway must durably deduplicate the key and attest receipt of the exact hash;
SunCharts cannot guarantee exactly-once delivery across an uncooperative system.

A connection that could not be established, or 429/503 with a matching
`status: not_received` receipt, permits up to three automatic attempts with
bounded exponential backoff. A matching 400/401/403/422 nonreceipt blocks the job.
Timeouts, disconnects after connection, malformed/oversize/mismatched receipts and
expired worker leases become `unknown`. They never automatically resend.

The web delivery queue shows attempts, state, receipt and append-only history.
Staff may cancel a queued/retry/blocked job or explicitly verify nonreceipt before
retrying an unknown/blocked job. Unknown jobs may also be reconciled to a verified
receipt without another network send. Those decisions require a reason, reference
and current job version. Leased jobs cannot be cancelled. Reserved artifacts and
claims cannot be manually changed in ways that race the worker. A delivered job
permanently prevents another automated job for that same artifact.

Leases commit before network I/O. A per-tenant transaction lock serializes billing
state; network I/O occurs outside that transaction. Result commits check the lease
identity. Audit failure rolls back clinical and delivery result changes. The next
lease recovery holds the uncertain result for review. One worker processes one
candidate each two-second tick; this is a bounded preview, not a throughput SLA.

## 277CA inbox

In **Electronic claims → 277CA acknowledgment inbox**, upload/paste the original
file and explicitly declare whether the issuer is a clearinghouse or payer.
Staging never changes a claim. The UI displays every parsed transaction, claim,
source/receiver/provider status, service status, qualified reference, date and the
original hashed text. Each claim row needs a separate reviewed native submission
match and current submission/claim versions. Imported multi-claim files stay one
immutable document with independent row decisions.

Supported input is bounded ASCII: 48 KB, one optional ISA/GS envelope, 20 unique
005010X214 ST sets, 100 patient claim rows and 100 services per claim. Envelope and
transaction counts/controls are checked; hierarchy is source 20 → receiver 21 →
provider 19 → patient PT. Patient TRN2 is the claim control. REF1K is the payer
control; REFD9 is retained separately as intermediary evidence. SVC/STC and FJ/6R
line controls retain service detail. QTY/AMT summaries remain in the original text
and do not drive claim decisions. Unsupported segments or statuses hold the row
or document for review rather than silently applying them.

A2/WQ can represent acceptance; A3/A6/A7/A8 with U rejection; A0/A1 receipt only.
Conflicting claim/service/ancestor evidence, unknown categories/actions or missing
or future claim status dates require review. Acceptance into adjudication does
not post payments or ERA ledger entries. The existing ERA workflow remains separate.

Applying requires the unchanged delivered submission, submitted claim, exact
native control or independently reviewed external alias, billing NPI, member ID,
receiver submitter ID and frozen payer identity. Clearinghouse issuer identity must
match the frozen payer or partner receiver identifier. Provided amounts must match
frozen charges; services require exact generated line controls/code/amounts.
DTP472 dates must match the native one-day service date (D8 or same-day RD8).
Payer acceptance additionally requires a payer control number. Technical rejection
or unresolved technical status blocks application. Clearinghouse acceptance records
evidence without changing the claim to payer-accepted. Clearinghouse rejection may
reject the unchanged claim while leaving payer outcome pending. Payer-origin
acceptance/rejection records the corresponding payer outcome. Duplicate row apply
and stale versions cannot overwrite subsequent claim or remittance decisions.

Broader hierarchy profiles, ambiguous/missing identities, service-only decisions,
contradictory files and unsupported code/loop combinations remain held. There is
no automated 277CA fetching, webhook receiver or inbox polling in this milestone.
Original documents and decisions are immutable; further evidence is a new document.
The older submission acknowledgment endpoint retains 277CA as historical evidence
only; use this inbox for claim-level application.

## Legacy migration

`scripts/export_legacy_clearinghouse.py --acknowledgments <json-file>` accepts an
array of `source_id`, `source_partner_id`, optional `source_claim_id`, `format`,
explicit local `path`, and optional `origin` (`clearinghouse` or `payer`). It
preserves exact original ASCII bytes as text and an allowlisted declared origin;
unknown fields and credentials are not copied. A source file is never inferred
from an untrusted process path. The existing frozen financial package carries
claim/encounter/patient relationships and historical processing metadata.

| Source evidence | Native review boundary |
| --- | --- |
| x12_partners nonsecret ISA/GS/submitter IDs | Owner-reviewed partner; defaults to test; no transport enrollment |
| claim x12_partner_id and source processing history | Historical relationship only; no generated artifact or queued send |
| Original 005010X214, source claim/partner IDs and declared origin | Global immutable edi_acknowledgment → staged 277CA inbox → separately reviewed claim rows |
| Historical delivery/claim status | Preserved source evidence; no native delivery, payer outcome or automatic replay inferred |
| Endpoint, token, password, connection settings | Excluded; operator must provision a separate route/adapter |

The Electronic claims source panel opens 277CA records in the new staging form.
A native document links back to the source history ID. Import must match original
text exactly and, when present, the source's declared origin. Reimports and review
replays cannot create duplicate decisions or activate old delivery jobs.

## API / evidence

API 0.7.0 adds `delivery/routes`, `delivery/jobs`, job detail/actions,
`submissions/{id}/delivery`, `277ca`, document detail and
`277ca/{id}/rows/{row}/apply` under `/api/v1/billing`. Billing OAuth scopes apply.
Staff reads and owner/clinician/front-desk workflow writes follow the existing
billing role boundary. Versioned actions require `If-Match`; row initial review
uses `"1"` plus explicit captured claim/submission versions. Migration 0011 adds
jobs/events and immutable acknowledgment documents/reviews.

References for scope and interpretation: [TMHP 277CA companion guide](https://www.tmhp.com/sites/default/files/file-library/edi/277CA%20COMPANION%20GUIDE_5010.pdf),
[X12 acceptance interpretation](https://x12.org/resources/requests-for-interpretation/rfi-1859-hix-grace-period-notifications),
and [Stedi's acknowledgment lifecycle](https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-277).
These inform the review boundary; this engine is not certified by those providers.
