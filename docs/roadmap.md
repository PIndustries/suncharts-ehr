# SunCharts EHR capability roadmap

SunCharts EHR is an independent Rust engine with an included web clinical workspace.
This synthetic-data development preview contains useful clinical and financial
foundations. Production clinical acceptance, external partner acceptance and
certification remain separate milestones. Endpoint counts and passing tests alone
do not establish that staff can complete a practice workflow.

**Verified locally** describes a bounded synthetic test or runtime check.
**Partial** means implementation exists with important gaps. **Missing** means no
complete native implementation was found. Current checks are recorded in
[verification.md](verification.md); new changes require their own evidence.

## Current native evidence and remaining work

| Domain | Native status and concrete evidence | Remaining native capabilities |
|---|---|---|
| Registration and patient identity | **Partial.** Create/list/read and tenant-local MRN protection in [model.rs](../src/model.rs), [postgres.rs](../src/postgres.rs), [visit tests](../tests/visit_workflow.rs). | A versioned contact/demographic profile is implemented alongside core identity. Broader identity data, identity correction/matching, patient merge, proxy relationships and source reconciliation remain. See [demographic scope](patient-demographics.md). |
| Scheduling and arrival | **Partial; bounded conflicts/versioning/visit handoff verified locally.** [scheduling.rs](../src/scheduling.rs), [scheduling.js](../web/scheduling.js), `native_scheduling_conflicts_versions_roles_and_visit_handoff` in [integration tests](../tests/connect_migrate.rs). | Working-hours templates, recurring series/exceptions, free-slot search, canonical facility/room administration, reminders, portal booking and tracker reporting. See [scheduling scope](scheduling.md). |
| Rooming and encounter documentation | **Partial; first clinician-owned visit verified locally.** Appointment → check-in → start → SOAP/vitals → sign → amendment → patient-scoped signed read in `complete_visit_is_durable_scoped_versioned_and_append_only`. | Delegated nurse/MA rooming, encounter diagnosis workflow, reusable forms/templates, richer histories/exams, independent checkout/follow-up and clinical acceptance. Vitals are currently protected by the same assigned-clinician lock as notes. |
| Longitudinal chart | **Partial; native list revisions/reviews/mapping verified locally.** [clinical.rs](../src/clinical.rs), [clinical.js](../web/clinical.js), list/reconciliation integration tests. | Expanded allergy reaction structures, validated terminology, complete medication instruction/adherence semantics, encounter linkage and portal release. Medication statements do not prescribe. See [clinical lists](clinical-lists.md). |
| Orders and results | **Partial; local order/specimen/panel/correction/acknowledgment verified locally.** [labs.rs](../src/labs.rs), [labs.js](../web/labs.js), order and source-mapping tests. | Real external order/result interfaces, requisition/label printing, terminology/units validation, specimen amendments, longitudinal trends, closed-loop communication and patient release. No PACS/RIS integration. See [orders scope](orders-labs-results.md). |
| Insurance and account ledger | **Partial; reviewed coverage, encounter charges and exact append-only accounting verified locally.** [billing.rs](../src/billing.rs), [billing.js](../web/billing.js), billing/version/concurrency tests. | Real 270/271 eligibility, fee schedules, responsibility allocation, patient statements, refunds/unapplied receipts, financial close and operational reports. Recorded payments do not collect money. |
| Claims, clearinghouses and ERA | **Partial; bounded native 837P, delivery/acknowledgment, 835/PLB and ordered batch correction behavior verified locally.** [x12.rs](../src/x12.rs), [delivery.rs](../src/delivery.rs), [retrieval.rs](../src/retrieval.rs), [era_batches.rs](../src/era_batches.rs), [era_chains.rs](../src/era_chains.rs), corresponding integration tests. | Live provider enrollment/credentials/acceptance, payer companion-guide validation, broader institutional/dental profiles, secondary/tertiary coordination, complete denial/appeal/status workflows and settlement operations. Local HTTP/SFTP fixtures are not live clearinghouse certification. See [835 scope](era-files-corrections.md). |
| Staff inbox and task ownership | **Partial for lab acknowledgment; general task system missing.** `/api/v1/labs/inbox` tracks current unacknowledged report revisions. | Assigned tasks, due dates, routing/delegation, escalation, reminders, messages, unresolved-order follow-up and durable completion evidence. A dashboard count is not a task workflow. |
| Patient portal | **Partial API only.** Signed-record access and patient scoping are tested in [visit tests](../tests/visit_workflow.rs). | Verified patient identity onboarding, usable native portal, release policy, messaging, requests/appointments/forms/payments and standardized record downloads. Existing SunCharts Patient identities are not yet mapped automatically. |
| Prescribing, immunizations, documents and referrals | **Missing native complete workflows.** Order categories and medication lists are narrower primitives. | eRx/renew/change/cancel and required network controls; vaccine administration/registry exchange; attachments, consent/forms, document signing and referral lifecycle. |
| Interoperability | **Partial; Patient read/search only verified locally.** [fhir.rs](../src/fhir.rs), `fhir_patient_boundary_is_scoped_and_honest`; [oauth.rs](../src/oauth.rs) has per-user scoped OAuth2. | Required clinical FHIR resources/searches, profile conformance, SMART/OIDC, Bulk Data, EHI export, C-CDA/Direct exchange, consent and terminology. OAuth2 alone is not SMART certification. |
| Migration/coexistence | **Partial; staged/reconciled archival import and selected explicit native mappings verified locally.** [migration.rs](../src/migration.rs), exporter/mapping scripts and integration tests. | Actual installation fixtures, source freeze/cutover validation, complete cross-domain mapping, reconciliation totals, identity/terminology resolution, rollback and clinic sign-off. `cutover_allowed` remains false. Preserving history does not activate native clinical/accounting state. |
| Administration/security/operations | **Partial.** Tenant/role boundary, sessions, scoped OAuth2, atomic audits, immutable signed content and ledger safeguards are tested. | Staff lifecycle/credential recovery/MFA, granular care-team permissions, configurable facilities/catalogs, audit tools, backup/restore drills, monitoring, migration/upgrade procedures, performance/accessibility/security review and incident operations. |
| Quality, population health and specialty workflows | **Missing native complete workflows.** | Clinical decision support, quality/population reports, public-health interfaces, recall management and the agreed specialty/module inventory. |

## Finish the practice journey first

The immediate acceptance target is a coherent **single ambulatory visit**, with
clinical, scheduling and financial work connected through patient/visit identity.
It is a smaller milestone than complete native workflow support. Parallel work should share
this journey and its contract rather than accumulate unrelated screens.

1. **Start the day:** show actual date/provider-filtered appointments, checked-in
   patients, open encounters and unacknowledged results. Distinguish unavailable
   data from zero work; expose bounded-list limits. Every action opens the correct
   patient and relevant workflow. Dashboard counters must be derived from persisted
   records; do not fabricate tasks or completion states.
2. **Register and arrive:** find or register the patient, review identity and
   coverage, book/reschedule, check in and open the appointment-linked visit.
   Contact editing is available; full identity and registration semantics remain separate work. Keep unknown coverage
   and allergy state distinct from verified absence.
3. **Room and document:** show the active encounter and current chart context;
   save vitals, assess the clinical lists and write the note with stale-version
   conflict handling. Until delegated rooming exists, clearly retain the assigned
   clinician boundary instead of implying nurse/MA authoring support.
4. **Order and review:** place a clearly labeled local order, record specimen and
   result, acknowledge the exact report revision and reopen review after correction.
   Unsent orders must not look transmitted. Clinical follow-up requires a real task
   or communication model before the UI claims it is completed.
5. **Sign and finish:** show unsaved changes and actual signing prerequisites.
   Signing presently completes the appointment; do not add an independent persisted
   checkout state in the UI without a backend transition. Do not imply signing
   automatically proves list review, results review, billing completion or discharge.
6. **Charge and follow up:** open encounter-linked coverage/account preparation,
   review codes and amounts, post charges, prepare claims and route outstanding
   work to their actual persisted state. Follow-up booking can use scheduling;
   reminders, AVS/patient instructions and patient delivery remain explicit gaps.
7. **Prove the whole path:** run one synthetic journey across the web, API and DB;
   reload/restart, revisit as the intended staff role, and verify original/history,
   patient isolation, conflict handling, failure states and resulting worklists.
   Retain screenshots and interaction evidence only after authorized visual QA.

## Next parallel work packages

| Priority | Work package | Concrete exit evidence |
|---|---|---|
| P0 | Practice navigation, dashboard, patient chart and encounter handoffs | One persistent synthetic patient journey through the web, including reload, empty/error states and correct patient context. Clearly label unsupported capabilities. |
| P0 | Backend journey contract and integration validation | Explicit transitions, current resource versions, role matrix and negative tests; server-derived readiness rather than browser-invented completion. |
| P0 | Evidence register and documentation consistency | Each capability has implementation, test, visual status, external acceptance status and remaining gaps. Reconcile milestone-era docs before describing a release. |
| P1 | Registration, rooming and care-team permissions | Expanded demographics with audit/version semantics; delegated authorship and scoped signing tested. No shared credentials or relaxed clinician-signature controls. |
| P1 | Durable staff work and visit completion | Assigned tasks, follow-up ownership, result escalation, checkout/AVS and patient release modeled end to end. |
| P1 | Real practice administration | Staff/roles, providers/facilities, resource/calendar catalogs and workflow settings operable without SQL edits. |
| P2 | External clinical and financial partners | Enrolled lab/eRx/clearinghouse test environments with retained partner acceptance, timeout/retry/duplicate reconciliation and live-route safeguards. |
| P2 | Portal, exchange and migration rehearsal | Patient identity/release journeys, fixed-profile FHIR tests and a complete frozen-source rehearsal with reconciliation and rollback evidence. |
| P2 | Operational readiness and certification track | Restore/upgrade/performance/security evidence plus separately scoped certification criteria, selected standard versions and formal test/assessment results. |

P0–P2 are ordering/dependency guidance, not calendar estimates. Agree on an
native capability acceptance baseline before turning this into a release acceptance matrix.

## Backend blockers visible to UI work

- [Patient](../src/model.rs) contains core identity; the separate audited/versioned
  [demographic profile](patient-demographics.md) holds contact details. Full identity
  correction, matching, merge and proxy models remain future work.
- [lock_visit/save_vitals/sign](../src/postgres.rs) intentionally enforce the assigned
  clinician. [Role](../src/auth.rs) has no nurse/MA role. A rooming redesign must
  preserve attributed authorship and signing authority.
- Signing updates appointment completion atomically, while charges have separate
  review/posting rules in [billing.rs](../src/billing.rs). No single persisted
  “everything completed” state currently joins those concerns.
- [Workspace](../src/model.rs) contains patient, appointments, visits and amendments;
  its SQL reads limit appointments/visits to 100 without continuation. Clinical,
  labs and billing load through separate requests. Whole-chart readiness and
  large-history completeness must not be inferred from those bounded responses.
- No general task/communication persistence was found. Do not make a cosmetic
  inbox that marks clinical work complete only in browser state.
