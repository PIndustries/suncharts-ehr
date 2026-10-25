# Product and backend boundaries

SunCharts EHR is a separate Git repository and deployable. SunCharts Engine is
its Rust server; `web/` is its independent clinical interface. A clinic can use
the open-source product without SunCharts SaaS or a subscription. Authentication,
the native database, audit trail and the first clinical UI run in this service.

The proprietary SunCharts repository retains its existing Apple/Android/web apps,
accounts, billing and source system connection management. Its new optional gateway
talks to this service over HTTP; it does not depend on the AGPL crate. The API
specification is Apache-2.0. A separate repository is a useful release boundary;
licensing separation depends on the actual software relationship, not folder names.

## Optional client connections

The clinic owner registers an exact OAuth2 callback for an independent SunCharts
application. Each staff member grants access separately; installation and user
identities remain independently pinned. Native patient portal reads are not yet
connected to an external patient identity. Matching email addresses or identifiers
must never substitute for verified identity mapping.

OAuth linking does not move clinical records or authorize a migration. A separate
legacy import is staged, reconciled and explicitly reviewed. Client connections
use HTTP contracts and do not link this Rust crate into another application.

## Native workflow

Patient identifiers are tenant-scoped. Booking serializes competing bookings per
tenant/clinician and rejects overlapping active appointments. An appointment
transitions `booked → checked_in → in_progress → completed`. A visit can be
created only from the assigned clinician's checked-in appointment. Only that
clinician can edit, sign or amend its documentation.

SOAP and vitals updates increment a version under a row lock. `If-Match` is required;
concurrent or stale writers receive 409. Signing requires a complete SOAP note,
attributes signer/time and completes the appointment in the same audited transaction.
The signed note and vitals remain unchanged when an amendment is appended.
Patient-scoped reads expose only signed visits and their amendments; failed reads
return an error, not a successful empty chart. Reads are also audited before return.

## Next milestones

- Extend the browser-verified first visit with account management/MFA and ongoing UI regression tests.
- Extend the implemented external identity mappings and reconciled archival import
  into clinically equivalent workflows; never keep two authoritative writers.
- Add coded observations/conditions/allergies/medications, units, provenance,
  consent, corrections and long-term history before producing conformant FHIR.
- Expand the initial FHIR Patient boundary and validate against pinned implementation-guide packages and
  selected Inferno tests, with results tracked per capability.
- Add attachments, lab interfaces, eRx vendor integration and claims workflows
  as separate milestones. A medication-list CRUD endpoint is not e-prescribing.

## Connection, events and migration

OAuth clients belong to an installation tenant; grants bind client + tenant + staff
user and current role. Secrets/tokens are hashed locally and encrypted in SunCharts.
No password/secret or full chart payload enters change notices. The feed is tenant
scoped and grant scoped; SSE checks revocation/expiry each second. Tenant advisory
locking orders audit inserts through commit so a replay cursor does not skip a
late-committing earlier notice. Consumers must tolerate reconnects and duplicates.

Migration jobs explicitly declare source instance/revision/counts/limitations. A
source ID mapping is distinct from a native patient UUID. Import commits all rows,
external identities and audit events atomically, preserving source history without
fabricating signatures. MRN conflicts block rather than merge patients silently.
See [migration.md](migration.md); cutover remains blocked in this preview.
