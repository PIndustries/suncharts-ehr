# Native patient contact and demographic details

This bounded native workflow adds contact editing to the patient chart. It is a
synthetic-data development feature, not complete registration or native workflow support.
The existing patient creation contract and core MRN/name/birth-date identity remain
unchanged. Historical claim/coverage snapshots are not rewritten by a contact edit.

## Staff workflow

In the patient chart’s **Patient details** tab, **Contact & demographics** displays preferred name,
pronouns, preferred language, phone, email, administrative gender, address and an
emergency contact. Owner, clinician and front-desk staff can select **Edit contact
details**, enter a reason and save. Read-only staff see the summary/history without
write controls. Patient credentials cannot read or write this staff-only profile.

Blank inputs become `null` (not recorded), never an assertion that the patient has
no phone, address or emergency contact. Administrative gender permits female,
male, other, explicit unknown, or null/not recorded; it does not represent sex
assigned at birth, clinical sex parameters or a complete gender identity history.
Phone/email are recorded contact details, not verified delivery destinations or
permission to send a message. Emergency contact is not consent, proxy authority,
a guarantor or insurance coverage.

The editor saves only its contact panel; it does not rerender or clear the active
encounter note. Version conflicts retain entered values and require explicit
reload/reconciliation. **Discard edits and reload** replaces the contact form
with current saved values. A failed network request may have committed; reload
before repeating a save. Patient-context checks prevent a late response for one
patient from rendering into another patient's chart.

## API and data rules

- `GET /api/v1/patients/{id}/demographics` returns `patient_id`, `version`, `content`,
  recent `history` and `history_truncated`, with a quoted ETag.
- `PUT` on the same route replaces the full contact profile using
  `{ "content": { ... }, "reason": "..." }` and the quoted `If-Match` version.
- Before the first save, version is **0**, all fields are null and history is empty.
  First save uses `If-Match: "0"`; subsequent saves advance the version by one.
- Content keys are `preferred_name`, `pronouns`, `language`,
  `administrative_gender`, `phone`, `email`, `address` and `emergency_contact`.
  Omitted optional values become null on replacement. Unknown keys fail validation.
- Address keys: `line1`, `line2`, `city`, `region`, `postal_code`, `country`.
  Emergency keys: `name`, `relationship`, `phone`; a name is required if any
  emergency contact detail is supplied. Entirely empty nested objects become null.
- Values are trimmed. Field limits are 100 characters for preferred name/pronouns/
  language/city/region/relationship, 200 for address lines/emergency name, 40 for
  phone, 254 for email, 32 for postal code and 2 for country. Country is normalized
  to uppercase two-letter syntax; membership in a country terminology is not validated.
- Phone accepts digits and common dialing punctuation; email has basic local/domain
  syntax checks. These checks do not establish a real phone/address/mailbox.
  Control characters and overlong values are rejected. A reason is required,
  trimmed, control-free and limited to 1,000 characters.

Staff reads are tenant scoped. Writes require owner/clinician/front-desk permission;
read-only and patient credentials cannot write. Existing clinical OAuth scope
policy applies through the authenticated router; these endpoints do not accept a
caller-supplied tenant. Missing patient/cross-tenant references return 404. Missing
or malformed quoted If-Match returns 428; stale versions return 409.

## Persistence and verification

Migration `0020_patient_demographics.sql` adds a current profile table and immutable
revision snapshots. SQL constraints independently validate the bounded content
shape/lengths, normalized contact syntax and update reasons. Patient identity and
version progression are protected. Revisions cannot be updated/deleted through
ordinary SQL, and current profiles cannot be deleted. These protections are not
claims against a database administrator.

The server locks the tenant's patient row before a profile replacement, checks the
current version, writes the next snapshot and commits its audit event atomically.
Concurrent first saves cannot both win. A failed audit rolls back the current
profile and history. Reads take a coherent profile/history view and audit access.
The response displays only the most recent 50 revisions and marks truncation;
earlier revisions remain retained in PostgreSQL. There is no full history export
or pagination endpoint in this bounded increment.

`tests/patient_demographics.rs` covers staff/patient/tenant access, initial unknown
state, trim/country normalization, stale and missing versions, concurrent writes,
independent service reconstruction on the same database, immutable history,
invalid content/identity keys, direct SQL constraint rejection and injected audit
failure rollback. Web syntax checks and backend tests do not establish interactive
visual or production acceptance.

## Remaining capability work

Expanded legal-name/identifier corrections and merge, full registration demographics,
sex/gender clinical semantics, communication preferences/consent, verified contacts,
multiple addresses/contact relationships, proxy identity, staff administration,
source-version migration mapping and standardized FHIR Patient representation remain
separate work. The current native FHIR Patient resource does not automatically
advertise these new fields. See the [workflow completeness roadmap](roadmap.md).
