# API

The staff browser sends `X-SunCharts-Staff-Context: <tenant_uuid>:<user_uuid>`
on authenticated requests. A malformed or mismatched context returns HTTP 409
before accessing records or changing the cookie session. Clients without this
optional header retain cookie API compatibility; first-party tabs clear their
local workspace and ask for sign-in when the shared browser account changes.

[api/openapi.json](../api/openapi.json) is the request/response contract. A running
server exposes the same specification at `/openapi.json`.

## Authentication

The browser signs in through `/auth/login` and uses an opaque HttpOnly,
SameSite=Strict cookie, marked Secure over HTTPS. Cookie-authenticated mutations
must include the configured Origin. Tenant and user identity come from the session.

Independent clients use OAuth2 authorization code with S256 PKCE. Discovery is at
`/.well-known/oauth-authorization-server`; token and revocation endpoints are
advertised there. Grants bind client, tenant and user. Tokens cannot exceed the
user's local permissions. Refresh tokens rotate; grants can be revoked.

Scopes cover clinical read/write, billing read/write, events, imports and offline
access. Native identity administration requires a local owner browser session;
a clinical OAuth scope does not grant staff-account administration.

The legacy HS256 gateway requires explicit server enablement and is disabled by
default. OAuth2 support alone is not SMART App Launch or OIDC.

## Writes and reads

Versioned writes require quoted `If-Match` values. Missing/malformed versions return
428 and stale versions return 409. Resource versions are distinct: rooming, encounter diagnoses, SOAP
and vitals share the encounter version, while checkout, tasks, accounts and other
resources have their own versions.

Use stable request UUIDs where the contract supports idempotent creation. Reusing
an identity with changed content is rejected. After a network failure, retrieve
the saved resource before deciding to repeat a write. Do not retry mutations blindly.

Clinical responses use `no-store`. Bounded worklists report their limits or
truncation flags; do not treat a loaded page as the complete chart. Native clinical
errors, patient-scoped reads and FHIR OperationOutcome errors have different
response shapes; use the documented endpoint contract.

The event feed offers tenant-scoped notices and SSE with expiry/revocation checks.
Consumers must handle reconnects and duplicates. Notices do not contain full chart
payloads or credentials.

## FHIR R4

The boundary exposes the native resources below. Patient registration, clinical
lists and single-test draft orders also support the bounded writes described here:

| Resource | Source | Search filters |
|---|---|---|
| Patient | Registration identity | `_id`, `name`, `identifier`, `birthdate` |
| Encounter | Native visits | `_id`, `patient` |
| Condition | Problem entries | `_id`, `patient` |
| AllergyIntolerance | Allergy entries | `_id`, `patient` |
| MedicationStatement | Recorded medication use/history | `_id`, `patient` |
| Observation | Visit-vitals panels and version-qualified report results | `_id`, `patient` |
| Appointment | Native scheduled appointment instances | `_id`, `patient` |
| Practitioner | Provider directory and owner/clinician staff | `_id`, `name`, `active` |
| Location | Recorded practice facilities | `_id`, `name`, `status` |
| Coverage | Registered insurance coverage | `_id`, `patient` |
| ServiceRequest | Native local orders | `_id`, `patient` |
| Specimen | Recorded specimen intake | `_id`, `patient` |
| DiagnosticReport | Current local report revision | `_id`, `patient` |
| DocumentReference | Native document metadata and immutable original references | `_id`, `patient` |
| MedicationRequest | Native local prescription orders | `_id`, `patient` |
| Binary | Immutable original document bytes | Read only; no search |
| Immunization | Native documented vaccine events/reports | `_id`, `patient`, `status`, exact `date` |

Searchable resources support `GET /fhir/{Resource}` and `GET /fhir/{Resource}/{id}`.
Binary supports only `GET /fhir/Binary/{id}`. Metadata at
`/fhir/metadata` advertises the implemented interactions and filters. Staff access
requires `clinical.read`, except Coverage requires `billing.read`. Patient-role
tokens cannot use this staff boundary. Practitioner/Location name searches use a
case-insensitive prefix. Practitioner `active` accepts `true`/`false`; Location
`status` accepts `active`/`inactive`. Other resource-specific filters are rejected.

Clinical `patient` filters accept a UUID or relative `Patient/{uuid}` reference.
All searches accept `_count` from 1–100, default 50, and an exclusive `_after`
cursor. Cursors are UUIDs except Observation, which accepts either a visit UUID or
its version-qualified lab-result ID. Follow the returned next link to preserve filters. This is live keyset
pagination, not a frozen snapshot; new lower-UUID records may require a fresh search.
Unsupported or repeated filters fail rather than being ignored. Empty search
bundles omit `entry`.

### Mapping details

- Appointment instances preserve start/end and patient/practitioner participants.
  Native check-in maps to `checked-in`; started/completed encounters map the
  appointment to `fulfilled`. Participant acceptance stays `needs-action` because
  booking does not record acceptance. Textual facility/room snapshots remain
  display-only supporting information; they do not invent Location references.
- Practitioner uses recorded display names and optional NPIs. Disabled/demoted
  providers are inactive; no specialty qualification or credential is inferred.
- Location currently exposes facilities only, with text address/phone. Rooms and
  organizations are not projected. A physical facility is not an Organization.
- Coverage exposes member identifier, beneficiary, recorded subscriber relationship,
  period, priority, plan/group and payer identifier/display. Dependent member IDs
  are not assumed to identify the subscriber. Registration does not establish
  eligibility, benefits or payment authorization. Native `inactive` does not
  distinguish cancellation/expiration: FHIR `_status` carries data-absent-reason
  `unknown` and a native-status extension preserves `inactive`. Active and
  entered-in-error statuses map directly.

- Encounters use visit creation/signature times, not booking times. Signed visits
  map to finished encounters; unstarted appointments are not encounters.
- Conditions retain supplied codes and verification. Error-marked conditions omit
  clinical status and abatement dates. Problem lists are not encounter diagnoses.
- Allergies retain supported reaction fields. Unknown criticality is
  `unable-to-assess`; missing records do not assert no known allergies.
- MedicationStatement is not MedicationRequest. Refuted statements use `unknown`
  with an explicit reason preserving their recorded status; native verification
  is retained in notes. Dose/route/frequency remain recorded text, not inferred
  prescribing instructions.
- ServiceRequest projects a local order, its requested tests, reason, priority and
  recorded destination. An active request does not establish external delivery.
  Completed orders do not imply a separately documented performed Procedure.
- Specimen projects recorded accession, collection/receipt times, type and body
  site. Rejected specimens map to `unsatisfactory`; received specimens map to
  `available`. Amended specimens and container/location tracking are not provided.
- DiagnosticReport exposes the current report status, issued time, order/specimen
  links and result references. It does not infer a clinical conclusion from notes
  or claim that an imported report signature was verified.
- Vitals remain one seven-component LOINC/UCUM Observation panel per recorded visit,
  preliminary before signing and final after. No measurement time is invented.
  Lab-result Observations preserve numeric comparators, recorded units, text/coded
  values, absent reasons, textual ranges and interpretation flags. Recorded lab
  units are not asserted to be validated UCUM codes.
- Each lab-result ID is `lab-{report UUID}-{report version}-{zero-based result
  ordinal}`. A report correction or reorder gets new IDs; published old references
  resolve their immutable report snapshots. These IDs identify revision slots,
  not persistent clinical-analyte identities. DiagnosticReport references the
  current revision's IDs. Observation search lists current results plus vitals;
  a specific `_id` can retrieve a previously published snapshot. Pagination is
  lexicographic across these IDs and remains live rather than snapshot-consistent.
  No standard FHIR version-history endpoint or independent vital-component search
  is provided.

Beyond the bounded writes below, other resource writes, general version-history,
code/date-range filters, includes, chaining and patient compartments are unsupported. US Core profiles, SMART, Bulk Data, EHI export,
terminology validation and formal conformance/certification remain unfinished.
### Patient registration writes

`POST /fhir/Patient` creates registration identity and returns `201`, a Location,
weak ETag and `meta.versionId`. `PUT /fhir/Patient/{id}` corrects an existing
identity; it never creates a missing patient. It requires `If-Match: W/"n"` (a
quoted strong version is also accepted) and a nonblank `X-Change-Reason` header.
The resource ID must match the URL. Stale versions return `412`; missing versions
return `428`; tenant MRN collisions return `409`, as FHIR OperationOutcome errors.

Writes require clinical.write and a clinician/owner role. Only resourceType, id,
meta.versionId, exactly one MRN identifier, one official name with one given name,
and birthDate are supported. Use the installation's `/identifier/mrn` system.
Unsupported fields such as addresses, telecom, extensions or multiple names fail;
they are never silently discarded. These writes do not alter contact demographics,
merge patients, provision accounts or grant access. Conditional creation and
transaction bundles are not implemented.

The Patient details web workspace uses `/api/v1/patients/{id}/identity` to read
and correct the same versioned registration identity, with immutable attributed
revisions. Corrections do not rewrite signed visit content. Existing identities
have an explicitly unattributed baseline; new application registrations record
an attributed initial revision in the registration transaction.

Reference baseline: [FHIR R4](https://hl7.org/fhir/R4/).


### Clinical-list and local draft-order writes

`POST /fhir/Condition`, `/fhir/AllergyIntolerance` and `/fhir/MedicationStatement`
create native list entries. Corresponding `PUT /fhir/{Resource}/{id}` corrects an
existing entry through the same attributed revision and review-invalidation
transaction as the native workspace. Both require `clinical.write` and an
owner/clinician role. Immunization additionally allows nurses as described below. PUT requires a matching resource ID, `If-Match: W/"n"`
(or quoted strong version), and nonblank `X-Change-Reason`. Stale versions return
412; absent versions return 428; errors are FHIR OperationOutcome JSON.

These are constrained request bodies, not arbitrary FHIR-resource persistence.
Use the typed writable schemas in OpenAPI. Codes require nonempty text; dates
accept complete `YYYY-MM-DD` values only. Conditions accept one supported
category and exact clinical/verification status coding systems. Error-marked
conditions/allergies omit clinicalStatus. Allergies accept one category, one
reaction and one text manifestation. MedicationStatement remains recorded use;
native verification and unrepresented structured dosage details are preserved.
One dosage.text is supported; changing an existing structured native dose, route
or frequency requires the native medication workflow. Unsupported fields fail,
including unsupported metadata, extensions or structured dosing fields.

`POST /fhir/ServiceRequest` and `PUT /fhir/ServiceRequest/{id}` support one-test
native draft orders only: `status=draft`, `intent=order`, one code.text with at
most one coding, one category.text (`laboratory`, `imaging`, `procedure`), one
reasonCode.text and one performer.display destination. Priority is routine,
urgent or stat; one note.text and a relative Encounter reference are optional.
PUT uses the same version/reason headers, preserves native test identity and
source provenance, and cannot edit placed orders (409). Multi-test editing,
placement and external execution remain native workflows. A draft write does
not transmit a request to a laboratory or other service.

Ordinary POST creates a new entry and is not replay-safe. Conditional and
idempotency headers are explicitly rejected for these FHIR writes. After an
uncertain network outcome, retrieve and reconcile the saved record before
repeating creation. Full-resource round trips may include read-only or unsupported
fields; send the supported writable subset instead of assuming every projected
field is writable.

### Document originals and local prescription projections

DocumentReference links its attachment URL to `/fhir/Binary/{document UUID}`.
Metadata corrections do not change original bytes or that URL. Native archive
status is not evidence that another document superseded the original, so it does
not assert a replacement; error-marked documents map to entered-in-error.
Binary defaults to FHIR JSON with base64 data and a DocumentReference
securityContext. Request the stored original MIME type (PDF, PNG or JPEG) through
Accept to download exact original bytes. Unsupported representations return 406;
responses use no-store, nosniff and attachment disposition. Binary search/writes
and patient-role access are not offered.

MedicationRequest projects only native prescription records. Draft, active,
cancelled, stopped and completed statuses describe the local order. Medication
name, supplied RxNorm code, recorded instructions, quantity/refills/days supply,
requester and prior-prescription references come from that record. Recorded
MedicationStatement entries do not become prescriptions. Local authorization,
printing or handoff do not establish pharmacy transmission, acceptance or dispensing.

## Patient portal authentication and release

The patient portal uses a separate `sce_portal` HttpOnly, SameSite=Strict cookie,
marked Secure over HTTPS and restricted to `/api/v1/patient-portal`. It is not a
staff cookie or an OAuth grant. Sessions expire after two hours or twenty minutes
of inactivity, and account/version revocation is checked on every operation.
Portal mutations require the configured Origin, including activation and login.
A staff/OAuth credential does not substitute for this patient cookie.
`GET /api/v1/patient-portal/session` returns the current account_id without
extending idle expiry. Other authenticated portal requests, including reads and
logout, must send `X-SunCharts-Portal-Account` with that UUID. A different or missing
account binding returns 409, preventing an old browser draft from being submitted
after another account replaces the shared cookie.

Scheduling-authorized staff invite a specific registered patient through
`/api/v1/patients/{patient}/portal/invite`. The response contains a single-use,
24-hour invitation URL for manual secure handoff; no email is automatically sent.
Account mutations require a quoted If-Match version, using `"0"` before the first
invitation. Activation sets a password of at least fifteen characters; login
requires practice_id, email and password. Revocation invalidates account sessions
and invitations atomically. There is no self-service password recovery flow here.

Patients see their own appointments, conversations and explicitly published AVS
versions. They cannot enumerate other patients or use the staff FHIR boundary.
Only the signing clinician can publish/hide a released AVS for their signed visit;
publication If-Match is distinct from the avs_version being released. AVS views
whitelist patient-facing fields rather than expose complete chart JSON. Appointment
change messages request staff attention and do not reschedule an appointment.
Replies and staff conversation status changes require the current quoted thread
version. Bounded lists report has_more/messages_has_more; they are not complete
history exports.

## Local prescribing

`/api/v1/prescribing/capabilities` reports the actual local boundary. Staff may
read patient orders and review snapshots. Owner/clinician/nurse/medical assistant
roles may prepare drafts; directory and preferred-pharmacy edits additionally
allow front desk. Only an owner/clinician may authorize, cancel, stop or complete
an order. Authorization requires an active selected pharmacy, a recorded NPI and
current allergy/medication review evidence, a fresh review_token and explicit
attestation. Controlled-substance authorization is blocked. Review evidence is
recorded clinical context, not automated drug interaction, dose, formulary or
contraindication checking.

Authorized content and signed snapshots are immutable. Changes require a new
draft; renewal/replacement links use prior_prescription_id and relationship on
creation, not action path values. Versioned edits/actions require quoted If-Match;
request UUID replay is bound to actor, operation and exact content. Preferred
pharmacy uses its body version instead. Reads and mutations return native quoted
ETags where the response is a single versioned record.

Printing displays the saved authorized record. record_print and fulfill_local
record local handling only; they require rooming authority and an active authorized
order. No eRx network, EPCS, pharmacy acceptance or dispensing endpoint is claimed.


### E-prescribing setup boundary

`GET /api/v1/prescribing/erx` is a local browser-only rooming read. It returns
candidate profiles, unverified preparation settings, eligible local mappings and
an explicit not-enrolled readiness result. There is no active provider or vendor
call. These endpoints do not accept OAuth clinical scopes in place of a local
browser session.

Owner-only `PUT /api/v1/prescribing/erx/connection` records preparation. An owner
or the same clinician can `PUT /api/v1/prescribing/erx/prescribers/{user}`. Both use
body `version` (0 for first creation), a stable `request_id` and a reason. Writes
require Origin and recheck current local permissions. Credential blocks are write
only; reads return stored/readable flags. Requests containing credential values
are encrypted for exact idempotent replay, never saved as plaintext or returned.
Changing candidates invalidates older mappings and requires explicit clearing or
replacement of prior credentials.

`GET /api/v1/patients/{patient}/prescribing/erx/attempts` returns the latest 100
readiness checks and a truncation flag. Clinician/owner `POST` records a blocked
check, bound to the expected `connection_version`, request UUID and optional
same-patient native prescription reference. This never updates the prescription,
launches a vendor workflow or contacts a provider. The database currently permits
only `outcome=blocked`, `vendor_contacted=false` and inactive connections.
## Immunization events

Native `/api/v1/patients/{patient}/immunizations` collection/item routes record
administered, historical and not-given events with immutable attributed revisions.
Writes require owner/clinician/nurse authority and `clinical.write`; medical
assistants retain read access. Native create/correction/error actions require a
stable actor/content-bound request UUID. Corrections and entered-in-error actions
also require a quoted current If-Match. Stale native versions return 409. The
performer directory lists active eligible local staff; historical performer
snapshots are preserved if that staff member later becomes inactive.

FHIR Immunization supports staff read/search and bounded create/update through
the same native write service. Search accepts `_id`, `patient`, exact `status`,
exact `date` (`YYYY-MM-DD`), `_after` and `_count` (1–100). A timestamp matches
its UTC date; a historical occurrenceString never implies an exact date. Empty
Bundles omit entry. Patient-role credentials cannot use this boundary.

FHIR writes require the explicit installation extension
`{origin}/StructureDefinition/immunization-record-type` with valueCode
`administered`, `historical` or `not_given`. This local distinction is separate
from primarySource; it is not inferred from that boolean. Exactly one complete
occurrenceDateTime or historical occurrenceString is required. Recorded performer
identifiers use `{origin}/identifier/staff`; a Practitioner resource or professional
qualification is not invented for nursing staff. Only the typed supported request
subset is accepted. Caller-supplied recorded timestamps, unknown extensions,
unsupported fields and conditional/idempotency headers fail. Ordinary FHIR POST
is not replay-safe; retrieve/reconcile uncertain writes before repeating them.

FHIR PUT requires matching id, If-Match (weak or quoted strong), and
X-Change-Reason. Stale FHIR versions return 412 with OperationOutcome. Record type
and status cannot change through correction; entered-in-error uses the native
reviewed action. These records do not provide vaccine forecasting, terminology
validation, inventory, registry enrollment/exchange, evaluation or recommendation
resources. See [FHIR R4 Immunization](https://hl7.org/fhir/R4/immunization.html).
