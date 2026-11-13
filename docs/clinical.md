# Clinical workflow

## Register and open a chart

Owners, clinicians and front-desk staff register a patient with their name and
birth date. The system assigns a unique MRN; staff cannot choose or edit it.
Existing and imported MRNs are preserved. The patient-details workspace
adds contact information, address, preferred name, pronouns, language,
administrative gender and an emergency contact, with attributed revisions.

Registered name and birth-date corrections retain versioned, attributed revisions. Patient matching, merge and proxy relationships are not implemented.
Changing a contact destination invalidates its reminder verification and consent
settings until staff reviews it again.

The primary chart navigation is **Overview**, **Encounter**, **Insurance**,
**Billing** and **Files**. Files opens all patient documents without selecting an encounter.
The Overview contact card displays the recorded phone and email and updates after
a successful contact save without reloading the chart. **Contact details** in the
chart header opens the same contact and demographics record.
**Patient record** contains **Contact & demographics**,
longitudinal problems/allergies/medications, histories, prescribing, referrals,
assessments, specialty care and imported records. These records remain available
without competing with the current encounter's workflow. Empty lists remain
unknown until explicitly reviewed; an empty allergy list is not an assertion of
no known allergies. An empty native billing list does not establish that imported
coverage, payments or balances do not exist.

**Patients** returns to the patient directory. The directory stays visible when
opening a chart; **Hide patients** and **Show patients** control its visibility.
The directory initially shows active patients. Choose **Archived patients** or
**All patients** to find a retained chart. **Archive patient** and **Restore patient**
require a reason and explicit confirmation from an owner, clinician or front-desk
user with clinical edit access. Archiving never deletes or rewrites visits, files,
signed notes, insurance claims or payments, and does not cancel appointments.
Restore the chart before creating appointments or starting a new encounter.
An encounter already in progress can still be completed by its authorized clinician.

Encounter history combines appointments with their linked visits. Completed rows
open the exact signed encounter rather than starting another visit.

Open **Encounter** to continue the selected visit directly. The encounter picker
changes the visit; its local steps are **Rooming**, **Notes & diagnoses (ICD-10)**,
**Procedures (CPT/HCPCS) & billing**, **Orders & prescriptions**, **Files & voice**, and **Checkout & AVS**, subject
to the staff member's permissions. Procedures and charges stay linked to that
encounter. Claim preparation and review remain in that encounter; the practice
claim queue and patient account summary provide cross-encounter views. Signing,
posting charges, submitting a claim and completing checkout
remain separate actions with their own readiness checks. **Insurance** shows
coverage and the recorded plan copay for the selected appointment's service date;
see [billing](billing.md) for receipts, patient invoices and claim follow-up.

**Start encounter** selects an existing appointment or creates one from an explicit
service date, time and duration. If booking or starting loses its response, continue
the same request: the EHR reads the existing appointment/visit before progressing.
The rooming view shows the available benefits for that service date. Starting an
encounter does not automatically submit an eligibility request.

Browser Back/Forward and the in-app Back control restore the patient, selected
encounter, local step and supported worklist detail. History contains view
identifiers, not clinical drafts or file bytes. Returning to a screen reloads it;
it never repeats the preceding payment, claim submission or other mutation.

## Clinical lists

Clinicians can record problems, allergies and medication statements, including
status, verification, dates, supplied codes and change reasons. Edits retain
attributed revisions and invalidate the previous list review. Codes are stored
as entered; terminology validation is not provided.

Medication statements describe recorded use or history. They are not prescriptions,
pharmacy instructions or an eRx service. Allergy reactions use the currently
supported text, severity and criticality fields.

## Prescribing

**Patient record → Prescribing** keeps prescription orders separate from medication
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

**Patient record → Surgical & dental history** records longitudinal history
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

Signed SOAP fields are labeled read-only. The assigned clinician can use **Add a
signed correction** to focus the amendment form; the original note stays intact.
Unsaved amendment text is retained only in memory in the current browser tab,
scoped to the staff session, tenant, patient and encounter. Navigating between
charts or refreshing chart data preserves that draft. Closing or reloading the
browser warns about unsaved corrections. If the encounter version changes, the
clinician must review the current record before signing the retained correction.

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

## Documents, file versions and voice

**Files & voice** separates **This encounter** from **Patient files**. Patient
files include every unlinked document, regardless of its category. **Other
encounters** expands files linked to other visits, with their original context.
The primary **Files** tab shows all loaded patient files. Encounter-linked files
show the appointment title and date when available, in both the list and preview. Category,
status and text filters apply to loaded pages; use **Load more files** for
additional records. Files retain their original links and are not copied into
each encounter.

**Patient intake forms** appears separately from uploads in Files and Files & voice.
It lists every form sent to the patient across their full history, with or without
an appointment, and shows a plain status for each: Sent, Started, Filled in – needs
review, Reviewed, Cancelled or Expired. The Overview also links directly to the
forms and shows the number awaiting review. **Load older forms** pages through the
retained records. Opening a form does not mark it reviewed or change the chart.
Clinical-view permission is required. The separate upcoming-readiness worklist
keeps its short scheduling window and is not the patient's intake archive.

### Patient intake forms

Every practice starts with the **standard intake form**. Patients answer it one
step at a time on a phone or computer:

1. About you
2. Contact
3. More about you (all optional)
4. Emergency contact
5. Who is responsible for the bill
6. How you will pay
7. Primary insurance (only when the patient chooses insurance)
8. Secondary insurance (only with insurance; the patient can skip it)
9. Pharmacy and one last question

The standard form never asks for a Social Security or driver's licence number.
A practice that has saved nothing uses it automatically. Under **Pre-visit
readiness → Booking and intake settings**, the owner chooses between:

- **Use the standard intake form**, optionally with **Add your own questions**.
  Each section added becomes an extra step after the standard steps. The settings
  page shows a read-only list of the standard steps.
- **Use only our own form.** Patients see only the practice's own sections. A
  practice that saved its own form before the standard form existed stays on this
  choice until the owner switches.

Each save is kept as a new revision. A form that has already been sent keeps the
questions it was sent with, whatever is saved later.

**Sending.** In the chart's **Patient intake forms** panel, owner, clinician and
front-desk staff use **Send intake form**. An appointment is not needed. The link
is shown once, with **Copy link** and **Email the link**; the email opens in the
staff member's own mail program, addressed to the patient's email on file, and
contains only the practice name and the link. The EHR itself sends nothing. A link
works for 30 days, or through the day of the appointment when the form is tied to
a later visit. Forms sent before this feature have no expiry.

**Send a new link** cancels a form the patient has not sent in yet and issues a
fresh link in one step; the old link stops working. **Cancel link** asks for a
reason and stops the link without issuing another. Filled-in and reviewed forms
are never cancelled or replaced. Booking continues to issue the practice's saved
form automatically when one exists; a practice with no saved form sends the
standard form from the chart or the readiness worklist.

**Choices instead of typing.** Wherever a known list exists the patient chooses
from it: state, phone type, language, relationships, marital status, race,
ethnicity, gender identity, sexual orientation and how they heard about the
practice. Choosing **Other** opens a text box. Insurance company and preferred
pharmacy are found by typing a few letters and picking a match from the practice's
own insurance companies, insurers the practice has already looked up in its
clearinghouse directory, and the practice's pharmacies; **I can't find mine**
switches to a text box. The list is available only through a working link and
returns names only.

**For the patient.** The page shows the practice name, the step number and a
progress bar. Answers are saved each time the patient continues, so they can close
the page and finish later on any device with the same link. Problems are shown
next to the question in plain words. A final screen lists every answer by step
with an **Edit** link, then asks the patient to confirm and type their name before
**Send to the practice**. An expired, cancelled or unknown link always shows the
same message asking the patient to request a new one. Repeated wrong links or
very frequent requests are slowed down for fifteen minutes.

**Review.** Opening a filled-in form shows every answer grouped by step. Contact
answers appear beside what the chart holds now, each with a tick box:

- ticked already when the chart has nothing for that item;
- left unticked when the chart holds a different value, so staff decide whether to
  replace it;
- no box when the chart already matches or the patient left it blank.

**Mark reviewed and add ticked answers to the chart** records the review and copies
only the ticked items to the patient's contact details: preferred name, language,
sex, phone, email, address and emergency contact. The change is versioned with the
reviewer, a reason and the form it came from. First name, last name and date of
birth are shown for comparison only and are corrected in the patient's profile.
For each insurance step the patient filled in, **Add as primary insurance** or
**Add as secondary insurance** opens the coverage form inside the review with the
member ID, group, plan and policy holder filled in. An insurance company the
patient picked from the practice's list, or typed exactly, is already selected.
Otherwise the practice's companies are listed closest match first, and the owner
can add the company as a new one in the same place (adding insurance companies is
owner-only); nothing is saved until staff save the coverage.
Marital status, race, ethnicity, gender identity, sexual orientation, the
responsible party, pharmacy, how the patient heard about the practice and the
practice's own questions stay on the form record and are not copied to the chart.

Owners and clinicians can upload PDF, PNG, JPEG, UTF-8 plain text, DOCX, XLSX,
MP3, WAV, Ogg, WebM and M4A files up to 10 MiB. Plain text is limited to 200,000
bytes. Each upload has a title, category, optional document date and encounter
link. Front-desk staff can manage **ID / driver's license**, **Insurance card**
and **Legal document** categories. Both the old and new category must be allowed;
reclassification cannot grant access to clinical document editing.

Select a file to preview it within the encounter. PDF pages are rendered locally
with the bundled PDF.js library; image and PDF annotations support highlights,
rectangles and text notes. Marks appear as a saved overlay on the correct page.
They do not alter or redact the underlying binary, and binary downloads do not
flatten these overlays. Text documents can be edited directly. Supporting text
documents do not replace or sign the encounter SOAP note. Audio uses explicit
playback controls. Word and Excel editing requires the configured service below.

Original file bytes, SHA-256, filename and upload attribution remain immutable.
**File version history** shows each appended working copy and annotation revision;
version 1 always opens the original. **Metadata history** separately records title,
category, encounter link and status changes. Saves require the current file or
metadata version and an attributed reason. Concurrent edits return a conflict;
review the latest saved file before explicitly retaining a draft against it.
There is no destructive deletion or overwrite of earlier versions. Uploads,
metadata, text and annotation drafts remain in this tab across navigation and
are cleared on sign-out or tab closure.

**Record voice note** requests microphone permission only after the user chooses
it. **Stop recording** ends capture and allows local playback. **Use this recording**
opens the regular upload form for review; **Upload document** is the action that
stores it. Capture stops when leaving the file workspace, changing patient or
encounter, hiding the page, or reaching ten minutes. Audio is limited to 10 MiB;
clips exceeding that bound are discarded. A stopped clip remains in this tab
until saved or explicitly discarded. Sign-out clears it. Recording does not send
audio to Sun, create a transcript, or edit a signed clinical note.

File reads, previews, downloads and saves require authenticated staff access to
the exact tenant, patient and document and commit an audit event. Preview responses
prevent caching and MIME sniffing and restrict framing to the same origin. The
service checks declared MIME types and file signatures; it does not scan for
malware or fully validate a PDF, image, audio or Office package. HTML, SVG and
arbitrary external document URLs are not rendered. File bytes are stored in
PostgreSQL by default, or encrypted in S3-compatible object storage when the
operator configures it (see [Patient file storage](operations.md#patient-file-storage)).
OCR, malware scanning, signature validation, consent execution and patient release
remain unfinished. Uploading alone does not release a file externally.

### Word and Excel editor service

Office sessions bind the document metadata revision as well as the patient, document and file version. Changing document details or its encounter link invalidates an open editor; reopen it to review the new context. Sessions created before this binding was added also require reopening. Original files and saved versions remain unchanged.

The EHR integrates ONLYOFFICE Docs for native DOCX/XLSX viewing and editing. It
is unconfigured by default; availability checks do not transfer a file. Provision
a compatible Document Server and configure:

- `ENGINE_OFFICE_ORIGIN`: the editor's exact HTTPS origin, without a path,
  credentials, query or fragment.
- `ENGINE_OFFICE_JWT_SECRET_FILE`: a private regular file containing the shared
  JWT secret, at least 32 characters, matching the Document Server's secret.
  Unix permissions must exclude access by group and other users.
- `ENGINE_OFFICE_CALLBACK_ORIGIN`: optional; defaults to and must match the EHR
  origin. The editor must reach that origin for scoped source downloads and saves.
- `ENGINE_OFFICE_ALLOW_LOCAL_TEST=true`: development only; allows loopback HTTP
  editor origins and `host.docker.internal` callbacks on the same port as the EHR.
  Production ignores this exception and requires HTTPS.

Opening the editor is explicit. The EHR supplies a signed, tenant/document/version
bound session and rechecks staff authorization for source reads and callbacks.
The service configuration must retain JWT validation. File transfer is limited
to that configured editor; never substitute an arbitrary public viewer URL.
The provider remains responsible for its own deployment, access, retention and
licensing configuration.

Use **Save to EHR**, then wait for the confirmed EHR file version. The editor's
local save indicator alone is not confirmation. The EHR waits until pending edits
reach the document service, requests a signed force-save operation, then accepts
only the matching authenticated callback and appends a new file version. A late
or uncertain save keeps the editor open and the original request identity available
for retry. Later edits remain unsaved even if an earlier operation is confirmed.
**Save & close** waits for confirmation; **Close without saving** requires explicit
discard. Browser and in-app Back are blocked while the editor is open. Original
uploads and prior versions remain intact.

See the official [ONLYOFFICE integration flow](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/opening-file/),
[callback contract](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
and [force-save command](https://api.onlyoffice.com/docs/docs-api/additional-api/command-service/forcesave/).

## Referrals

Clinicians create encounter-linked or standalone patient referrals with a
recipient, requested service, clinical reason/summary and optional follow-up date.
Choose active patient documents explicitly. Draft and ready referrals can be
edited; editing a ready referral resets it to draft. Marking ready captures the
selected metadata and current file versions, hashes, and saved annotations.
Delivery uses the exact reviewed file bytes. A later edit requires a new readiness
review before sending. Saved annotations accompany each file as separate metadata;
they are not flattened into its bytes. Existing packets without a file version
retain their original-file binding and remain unchanged. Recording a sent milestone
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
selected reviewed file versions. Closing the browser does not cancel a queued job.

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

Patient-scoped APIs can read signed records and the latest released AVS. The
patient portal's access and release limits are described above; proxy access is
not implemented. See the [API guide](api.md) for access rules and response limits.

## Immunization records

**Patient record → Immunizations** distinguishes an administered vaccine, a historical
report, and an event where a vaccine was not given. Owner, clinician and nurse
roles may record or correct events; medical assistants and other staff may read.
Saving documents an event. It does not administer a vaccine, decrement inventory,
validate a vaccine schedule or transmit to an immunization registry.

For an administered event, select the actual administering staff separately from
the recorder and choose the actual date/time and its recorded UTC offset,
recorded dose/unit, route and site. The date/time picker supports milliseconds;
notes-only corrections preserve the complete stored precision. New records require
an explicit offset selection, and no local time zone is assumed.
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
