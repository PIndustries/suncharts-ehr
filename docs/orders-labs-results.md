# Native orders, laboratory panels and results

SunCharts EHR now supports a local order-to-result workflow with its own web UI.
This is a synthetic-data development milestone. Live lab interfaces are not connected.

## Clinical workflow

Create a draft with category (laboratory/imaging/procedure), priority, destination,
clinical reason, instructions, requested tests/panels and optional related native
visit. Edit while draft, then explicitly place locally. Placed order content is
preserved; cancel and create a replacement when instructions change. Local placement
does not claim transmission, laboratory acceptance or receipt of an external order.

For laboratory orders record received/rejected specimen intake with accession,
specimen type, collection/receipt times, site and notes. Rejection requires a reason;
rejected specimens cannot support result entries. Intake is immutable and a
replacement uses a separate record. Correcting a previously recorded intake or
retrospectively rejecting an accepted specimen remains a capability gap.

Record preliminary/final reports containing one or more requested test keys and
numeric, text, coded or unavailable observations. Results carry supplied units,
reference ranges, interpretations, notes, laboratory identity and reported time.
Numeric comparators and absent-result reasons are explicit. Values are typed;
empty is not zero, unknown is not normal, and incompatible value fields are rejected.
Units and terminology are recorded as supplied, without UCUM/LOINC validation.
Flags are not automatically inferred from a reference range or used to make clinical
decisions. Critical flags appear prominently in the chart and results inbox.

Final native laboratory reports require a received specimen belonging to the order,
and cannot predate its receipt. An explicitly reconciled imported source report may
retain missing native specimen information without fabricating a collection.
The chart clearly labels this exception and its unverified external signature.

Preliminary reports can be edited/finalized. Final/corrected reports require a new
attributed corrected/error revision; they cannot be silently rewritten. Every report
revision and order state snapshot records author/time/reason and rejects ordinary
SQL UPDATE/DELETE. Database-administrator tampering is outside these guarantees.
Every mutation and its audit event commit together; injected audit failure rolls
back values, revisions and order state. All queries scope authenticated tenant and
patient. Owner/clinician roles write; other staff read. Patient-portal release is
pending. Network failures leave outcome unknown until reconciled; no writes retry
automatically. Required request UUIDs make exact order/specimen/report creates safe
to repeat, while changed reuse conflicts.

The clinic **Labs & results** inbox lists up to 100 current unacknowledged report
revisions. Preliminary results can also be acknowledged, so supplied critical
preliminary findings do not wait for finalization to enter the review workflow.
Acknowledgment records an attributed interpretation/follow-up note for that specific
version. It does not send messages, page a clinician, prove closed-loop communication
or release a result to a patient. Prior acknowledgment stays in history after a
correction; the corrected revision requires another review. Completing an order
requires final/corrected coverage for every requested test and review of every
current non-error report. A correction reopens a completed order.

## Legacy migration

Inspect source order/report/result schemas and freeze the source revision before
exporting; a preserved source row is not proof of clinical equivalence.

`scripts/export_legacy_labs.py` joins source EHI CSVs into an existing SunCharts
export package. Provide `--base-package`, `--ehi-dir`, `--source-revision`, `--out`
and `--confirm-same-snapshot`. Required CSVs: procedure_order, procedure_order_code,
procedure_report and procedure_result. The base package's original patient `pid`
maps to its stable source patient ID. Missing/duplicate/orphan relationships stop
the whole conversion. Output is published atomically, mode 0600, without overwrite.
The operator must ensure both exports represent the same frozen source snapshot;
this is not independently verified and no live source writes occur.

| Source | Preserved / mapped treatment |
|---|---|
| procedure_order ID and patient_id | Stable `lab_order` source identity, mapped to the base patient |
| procedure_order_code order/sequence and name | Requested-test key/description; code system translation requires review |
| clinical_hx / patient_instructions / source metadata | Suggestions or original context; reviewer supplies missing title, destination and classification |
| procedure_report order ID and sequence | Source order/report link and requested-test coverage |
| specimen_num / report notes | Suggested report accession and notes |
| date_report and date_report_tz | Parsed only with explicit offset/RFC3339; otherwise reviewer must supply time |
| procedure_result data type / result / units / range | Suggested typed value and original units/range |
| abnormal | Known N/H/L/HH/LL values become supplied interpretation flags; unknown values remain unknown |
| result_code / source vocabulary | Preserved for explicit terminology mapping; no blind validated-LOINC claim |
| Source author, signatures, statuses and extra fields | Original data preserved; external signatures stay unverified |

Import the package through migration staging/reconciliation. Canonical source
order/report references are checked for the same patient. Open imported history
and select **Reconcile lab source**. Reconcile the order first; place it locally
without external retransmission, then reconcile its report. The mapping shows raw
source fields and requires explicit clinician review. Source report status does
not automatically publish a final native result; the reviewer chooses status.
Source rows are linked once and originals remain unchanged. Corrections append
native revisions and never write back to source system. All jobs keep cutover blocked.

## Workflow completeness gaps

The native workflow is implemented; complete native workflow support remains work. Exact legacy
REST/FHIR contracts, provider/test catalogs, installation-specific code translation,
complete specimen EHI and document exports, specimen amendments, requisition/label
printing, external order delivery/cancel acknowledgments, HL7/ASTM/vendor result
ingestion, duplicate/interface-message reconciliation, microbiology/susceptibility,
pathology/image attachments, result trends, clinical escalation, patient release,
large-history pagination and validated FHIR ServiceRequest/Specimen/Observation/
DiagnosticReport are pending. Imaging/procedure categories support local orders and
manual reports, not a PACS/RIS integration. No ONC certification is inherited.
