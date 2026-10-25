# Native problems, allergies and medication lists

This milestone adds longitudinal clinical list workflows to SunCharts EHR.
Native APIs have their own contracts and version controls.

## Workflow

A clinician/owner can add and edit a problem, allergy or medication statement,
record onset/end dates, clinical status, verification, codes, notes and the reason
for each change. Readers can view current lists and immutable attributed revision
snapshots. Front-desk and read-only roles cannot write these lists. Patient-portal
release of these lists is pending; they are currently staff-only.

Problems support active, inactive, resolved, recurrence, remission and error states,
and problem/diagnosis/health-concern classifications. Allergies record category,
reaction text, reaction severity and future-risk criticality. Medication statements
record dose, route, frequency and indication with active/on-hold/stopped/completed/
not-taken/intended/error states. These document the medication list; prescribing,
pharmacy delivery, dispensing and eRx-network workflows remain separate work.
Terminology codes are stored as provided, without a terminology validation claim.
Dates and allowed status combinations are validated; entered-in-error requires
matching verification. No hard-delete endpoint removes clinical history.

Each edit requires a quoted current If-Match version. A row lock plus immutable
revision and atomic audit prevents stale writers from silently overwriting changes.
Every list has its own review version. Empty lists are unknown until assessed;
no-known assertions are explicit, and conflict with current nonrefuted entries.
Unknown/unable-to-confirm remains distinct from reviewed or no-known. Reviews have
an attributed note and append-only history. Every native change or newly imported
source entry invalidates the current review and increments its version.

## legacy source mappings

Inspect and pin the source schema revision before using migration mappings.
Live-source validation has not been completed.

| Source field | Native treatment |
|---|---|
| medical_problem / allergy / medication | Problem / allergy / medication statement reconciliation candidate |
| title | Suggested clinical title; missing values require clinician entry |
| begdate / enddate | Suggested calendar onset/end dates; original timestamp retained in source history; zero dates become unknown |
| activity and enddate | Suggested active vs inactive/stopped state; clinician must confirm |
| comments | Suggested native notes; immutable original preserved |
| diagnosis | Source code text retained for review; no blind conversion to validated codes |
| reaction | Suggested allergy reaction text |
| severity_al / classification / verification / outcome | Original source fields visible; installation-specific values require explicit clinical mapping |
| dosage / route / frequency when present | Suggested medication instruction fields; clinician must confirm |
| drug_dosage_instructions / usage_category / request_intent / adherence and prescription references | Preserved source context; full structured native equivalents and source export coverage remain work |
| Original author / site / source IDs / extra fields | Preserved source history and stable source identifiers; never rewritten as a newly signed native record |

After importing a snapshot, open **Imported clinical history → Reconcile into native
chart**. The mapping preview displays original fields, suggestions and review issues.
The clinician confirms the patient and values, supplies a reason and creates the
native entry. A permanent source-history reference links the native revision to the
unchanged original. One source row can create only one native entry; reopening it
edits that entry with a new revision. Native edits never overwrite archival data or
write back to source system. Imported lists must be reconciled before marking the list
reviewed/no-known. General patient matching, duplicate clinical concept detection
and merging are pending; separate source rows are not silently merged by title.

## Workflow acceptance still required

Workflow completeness is the project target, not a completion claim. For these domains,
remaining gaps include source-version fixtures, per-installation lookup-code translation, multiple coded
allergy reactions/manifestations, encounter linkage, reusable historical context,
expanded medication/adherence data, prescribing/renewal interactions, terminology
services, coded units, clinical review and FHIR Condition/AllergyIntolerance/
MedicationStatement validation. Source preservation is not workflow equivalence.
The production migration cutover guard remains false.
