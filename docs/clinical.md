# Clinical workflow

## Register and open a chart

Owners, clinicians and front-desk staff can register a patient with an MRN, name
and birth date. MRNs are unique within a practice. The patient-details workspace
adds contact information, address, preferred name, pronouns, language,
administrative gender and an emergency contact, with attributed revisions.

Registration identity corrections retain versioned, attributed revisions. Patient matching, merge and proxy relationships are not implemented.
Changing a contact destination invalidates its reminder verification and consent
settings until staff reviews it again.

The chart groups clinical lists, encounters, orders/results, checkout, financials
and imported source records. Empty lists remain unknown until explicitly reviewed;
an empty allergy list is not an assertion of no known allergies.

## Clinical lists

Clinicians can record problems, allergies and medication statements, including
status, verification, dates, supplied codes and change reasons. Edits retain
attributed revisions and invalidate the previous list review. Codes are stored
as entered; terminology validation is not provided.

Medication statements describe recorded use or history. They are not prescriptions,
pharmacy instructions or an eRx service. Allergy reactions use the currently
supported text, severity and criticality fields.

## Prescribing

The **Prescribing** chart tab keeps prescription orders separate from medication
statements. Staff can prepare a draft, select a pharmacy and record directions,
quantity, refills and the intended visit. Only a clinician with an active provider
profile and NPI can authorize it. Controlled-substance authorization is blocked.

Before authorization, review the current patient, allergy and medication context
and record the required safety attestations. An unknown or changed list blocks
use of an old review. These attestations record a human review; the service does
not provide interaction checking, dose validation or a prescribing knowledge base.

Authorization preserves the reviewed content and context. Staff can print the
local order and record handoff, cancellation, discontinuation or completion with
attribution. Renewal creates a new draft linked to the predecessor; authorizing a
replacement stops the predecessor atomically. A local authorized or handed-off
order does not prove electronic transmission, pharmacy acceptance or dispensing.
E-prescribing networks, EPCS, refill messages and pharmacy reconciliation remain
unfinished. Unsaved edits remain only in the current browser session.

## E-prescribing enrollment preparation

The **Prescribing** workspace includes **E-prescribing setup**. It starts with no
provider selected. An owner can compare documented candidate workflows, record
an evaluation candidate, desired capabilities and enrollment progress. These are
staff reports; saving them does not connect a vendor. Clinicians can prepare their
own prescriber/location mapping; an owner can prepare eligible local mappings.

Optional organization and prescriber credential blocks are encrypted by this
server. Supply credentials only after the practice has a vendor agreement and
receives test access. Blank inputs retain a stored block; supplying any credential
replaces the entire block. Use explicit clearing when changing candidates. Earlier
candidate mappings require re-review. Do not enter patient records, EPCS
one-time codes or authenticator secrets in these fields.

**Record current readiness check** creates an attributed, immutable check for the
current chart. It always records that it was blocked before vendor contact. It
does not open vendor prescribing, send a native draft or alter the prescription
list. No network adapter, receipt synchronization or EPCS function is active.

Before enabling a real integration, the practice must select and enroll with a
provider; obtain its current technical contract and test access; establish the
required prescriber/location identities, drug/pharmacy data and receipt handling;
and complete the provider's acceptance process. Candidate descriptions link to
[Photon's public integration guide](https://docs.photon.health/docs/integration-guide),
[Weno's hosted workflow overview](https://wenoexchange.com/wp-content/uploads/2025/08/EZ_Integration_Overview.pdf),
[Weno's separate Online API overview](https://wenoexchange.com/wp-content/uploads/2025/07/WOL_API_Overview-07-21-2025.pdf)
and [DoseSpot's integration process](https://dosespot.com/full-integration/).
A vendor-hosted composition workflow is distinct from transmission of a locally
authored prescription. A launch or local authorization cannot establish pharmacy
acceptance or dispensing.

## Patient portal

The standalone `/patient-portal` uses patient accounts and sessions separate from
staff sign-in. Staff opens **Patient portal** from a chart to issue an expiring,
single-use invitation and hand it to the verified patient through a secure channel.
The invitation is not emailed automatically. Staff can revoke access immediately.

Patients can review their appointments, request a change to a booked or checked-in
appointment and send
secure messages. Requests enter **Patient messages** for staff review; they do not
automatically alter the schedule. Conversations retain attribution and status.

A signed visit summary becomes visible only after the assigned clinician explicitly
publishes a released after-visit-summary version. Later internal chart edits do not
silently change that publication. The portal does not expose draft notes, source
archives or unrestricted clinical records. Broader results/document release,
guardians, identity proofing, account recovery, MFA and attachment exchange remain
unfinished. Use synthetic accounts while these production requirements are open.

## Surgical and dental history

The **Surgical & dental history** chart section records longitudinal history
separately from problems, encounter diagnoses and procedure orders. Clinicians
and owners can add or revise entries; other staff can read them. Record status,
verification, optional dates and a supplied terminology code, notes and a change
reason. Dates and codes are recorded as supplied; there is no terminology lookup.
The history kind cannot change after creation. Correct an entry through an
attributed revision or mark it entered in error; records are not deleted.

The workspace filters the loaded entries by kind and status and offers additional
pages. Revision history retains author, reason and prior content; the view shows
at most 100 revisions and identifies omitted older revisions. Unsaved edits stay
in the current browser tab, including when moving between charts. After a stale
save, compare with the current record and explicitly retain edits against its
version. Closing or reloading the tab discards unsaved history.

History APIs support patient-scoped list, create, read, update and revisions.
Creation requires a stable request UUID; retrying the same request returns the
existing record, while reusing the UUID with different content fails. Updates
require the current entry version through `If-Match`. Surgery and dental entries
are not exported as FHIR Procedure or Condition resources yet.

## Arrival, rooming and documentation

1. Front desk checks in a booked appointment.
2. The assigned clinician or an enabled nurse/MA starts the encounter. Starting
   it preserves the appointment's assigned clinician.
3. Rooming staff records a chief complaint, intake notes and vitals. Marking intake
   **Ready for clinician** requires a complaint and medication/allergy review
   attestations. These attestations do not edit the longitudinal clinical lists.
4. The assigned clinician reviews the chart, records encounter diagnoses, saves
   SOAP and signs the encounter. Signing completes the appointment and locks the
   original note, diagnoses, intake and vitals.
5. Corrections to signed documentation use attributed amendments.

| Role | Intake/vitals before signing | SOAP/sign/amend |
|---|---|---|
| Assigned clinician or owner assigned to visit | Yes | Yes |
| Enabled nurse or medical assistant | Yes | No |
| Front desk or read-only staff | No | No |

Intake, note and vitals writes share the encounter version. Stale saves fail with
409. Unsaved browser edits remain in the current tab; comparison is required after
another author changes the record. Closing or reloading the tab discards unsaved
edits. History distinguishes the staff member who recorded intake/vitals from the
clinician who signed.

## Encounter diagnoses

The assigned clinician can record up to 20 ordered ICD-10-CM diagnoses before
signing. The first diagnosis is primary. Add, edit, reorder or remove entries and
supply a change reason when saving. The entire ordered list is saved together;
each revision retains the author, reason and previous recorded assessment.

Codes are trimmed, uppercased and checked for supported syntax. Code descriptions
are clinician supplied; terminology edition validation and code lookup are not
implemented. Duplicate canonical codes are rejected. These encounter diagnoses
are separate from longitudinal problems and do not automatically change orders
or billing.

Diagnoses share the encounter version with notes, intake and vitals. Concurrent
changes require comparison and a fresh version. Signed diagnoses are read-only;
clinical corrections use attributed note amendments. Structured diagnosis
corrections after signing remain future work. Staff can review the most recent
100 revisions; the API reports when earlier history is omitted.

Reusable note templates, richer histories/exams and expanded nursing workflows
remain on the [roadmap](roadmap.md).

## Documents

Clinicians can upload PDF, PNG or JPEG originals up to 10 MiB, with a title,
category, optional document date and encounter link. The service checks declared
media type and file signatures; it does not scan for malware or validate a complete
PDF/image structure. Staff downloads use authenticated attachments with no inline
preview. Uploading does not release a document to the patient or send it externally.

Original file bytes, SHA-256 and upload attribution remain immutable. Clinicians
can revise metadata or mark a record archived/entered in error, using the current
version and an attributed reason. Staff can inspect revision history and download
preserved originals. There is no destructive deletion or original-file replacement;
upload a separate record for a new file. The web editor retains selected files
and unsaved metadata in the current tab, and requires comparison after conflicts.
Files and drafts are cleared on sign-out and lost when the tab closes.

Category/status filters apply to loaded pages; use **Load more documents** to
inspect additional records. The API also accepts server-side category/status
filters. Document storage is local PostgreSQL bytea; OCR, malware scanning,
signature validation, consent execution and patient release remain unfinished.

## Referrals

Clinicians create encounter-linked or standalone patient referrals with a
recipient, requested service, clinical reason/summary and optional follow-up date.
Choose active patient documents explicitly. Draft and ready referrals can be
edited; editing a ready referral resets it to draft. Marking ready captures the
selected document versions, metadata and hashes. Recording a sent milestone
requires active documents unchanged since that review; sent content then locks.

Manual sent, accepted, scheduled and completed milestones require staff-entered
evidence. Recording a manual milestone does not transmit a package. Lifecycle
changes retain attributed revisions. The practice worklist supports status,
overdue and paginated review; overdue uses the server's UTC date. A follow-up date
does not create or assign a staff task automatically.

### External referral delivery

Practice owners configure receiving gateways from **Referrals → Delivery
destinations**. Enter the receiving practice's HTTPS gateway address and optional
bearer credential, then explicitly enable the destination. Saved credentials are
never displayed again. The installation operator must allow the gateway hostname
in the server configuration before it can be used.

For a ready referral, choose **Review external delivery**, select the destination,
and inspect the patient, recipient and document package. The review captures
referral/destination versions and document hashes; changing the package requires
another review. Enter a delivery reason, acknowledge the reviewed package, then
choose **Send reviewed referral**. The durable job sends the referral details and
selected original files. Closing the browser does not cancel a queued job.

**Delivery status** shows queued, sending, gateway-accepted, unknown, not-sent or
cancelled outcomes. Staff can cancel a job while it remains queued. A gateway
receipt advances the referral to sent; it does not establish receiving-clinician
acceptance, scheduling or completion. Those remain separate evidence-based
milestones. This adapter requires a compatible receiving HTTP gateway; it does not
provide fax or Direct messaging.

An unknown outcome can mean the receiver obtained the package without a confirmed
receipt. Authorized clinical staff check the receiver's delivery record and
record either its receipt or evidence that it was not received. The screen does
not offer an automatic resend for unknown outcomes. Retained browser edits remain
separate from the package already queued or delivered.

## Orders and results

Create a draft laboratory, imaging or procedure order, select requested tests,
then place it locally. Local placement does not transmit the order externally.

Laboratory orders support specimen intake and typed numeric, text, coded or
unavailable observations. Reports can be preliminary, final, corrected or entered
in error. Corrections append revisions; they do not replace the original report.

The results inbox tracks acknowledgment of each current report revision. A
correction reopens review. Completion requires final/corrected coverage of every
requested test and acknowledgment of the relevant current reports. Acknowledgment
does not notify a patient or prove closed-loop follow-up.

External lab interfaces, requisitions/labels, specimen amendments, longitudinal
trends, imaging attachments and patient result release are not implemented.

## Checkout and follow-up

After signing, the assigned clinician reviews the prospective patient summary,
writes patient-facing instructions and releases an immutable AVS version. SOAP
text and internal medication/order notes are not copied automatically. The released
medication list contains recorded medication statements; native prescription orders
are separate and are not included in that list.

Staff records print, decline or other handoff evidence against that AVS version,
then completes administrative checkout. Opening a print dialog alone is not
handoff evidence. A corrected AVS creates a new release and requires fresh handoff
and checkout review. Earlier versions remain available.

Create encounter-linked follow-up tasks with an enabled assignee and due date.
Tasks can be completed, cancelled, reopened, reassigned or rescheduled with a
reason and current version. Checkout does not close tasks, collect payment,
acknowledge results or send prescriptions.

AVS snapshots support at most 100 entries per clinical-list kind and 100 linked
orders; larger summaries fail rather than truncate silently. Staff reads retain
bounded release/event/task histories with truncation flags.

Patient-scoped APIs can read signed records and the latest released AVS. A patient
portal with identity onboarding, proxies and messaging is still missing. See the
[API guide](api.md) for access rules and response limits.

## Immunization records

The Immunizations chart tab distinguishes an administered vaccine, a historical
report, and an event where a vaccine was not given. Owner, clinician and nurse
roles may record or correct events; medical assistants and other staff may read.
Saving documents an event. It does not administer a vaccine, decrement inventory,
validate a vaccine schedule or transmit to an immunization registry.

For an administered event, select the actual administering staff separately from
the recorder and enter the actual timestamp with seconds and an explicit UTC
offset (or Z), recorded dose/unit, route and site. Notes-only corrections preserve
the stored timestamp precision; ambiguous offset-free local times are rejected.
Historical records accept a complete date, timestamp, or explicit unknown-date
text; no date is guessed from a narrative. A not-given event requires its reason
and cannot assert an administered dose, lot or performer. The primary-source
choice states whether information came from the administering person; secondary
reports require the recorded source. Vaccine codes and manufacturer text are
recorded as supplied; no catalog, CVX validation or clinical dose checking is
claimed. Lot and product expiration may be recorded when known.

Corrections require the current version and a reason and append a new attributed
revision. The prior record remains available through Revision history. Staff labels
use the current directory name/email, with an immutable actor-ID fallback; they
are not historical identity snapshots. The editor
retains unsaved changes after a conflict and offers explicit comparison/rebase.
A mistaken event can be marked entered in error through an inline reason/review
form. The reason, version and request identity survive an uncertain response;
compare the saved record before retrying or rebasing. That terminal
record cannot be reopened or deleted. Record the replacement separately rather
than turning a not-given event into an administration. Empty lists do not establish
immunity, vaccine completeness or which vaccines are due.
