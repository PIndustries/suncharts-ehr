# Clinical breadth and interoperability targets

Standards reference check: October 23, 2026; native capability inventory updated
October 25, 2026. This is an implementation roadmap and evidence register, not a
certification claim. Clinical behavior, supported data elements, profile conformance,
security and certification require distinct acceptance evidence.

## Clinical breadth

The [capability roadmap](roadmap.md) describes native workflows and explicit gaps.
SunCharts APIs have independent contracts; documented endpoints alone do not
establish complete clinical support.

| Data/workflow domain | Native status | Remaining native capabilities |
|---|---|---|
| Patient demographics / identifiers | Partial | Expanded demographics, terminology, search, identity matching/merge, external IDs, history |
| Scheduling / encounters | Native booking/rescheduling, check-in, cancellation/no-show, provider blocks, timezone-aware UI and encounter handoff | Working-hours availability/free-slot search, recurrence, canonical provider/facility administration, delegated rooming, encounter types/dispositions and checkout |
| SOAP / vitals | Initial visit implemented | Coded observations, effective times, reference ranges, units/UCUM, full provenance and reusable note templates |
| Problems / allergies / medications | Native lists with web UI, status/verification, codes, revisions and source reconciliation | Complete field semantics, validated terminology, source-version coverage, expanded allergy/medication data and FHIR profiles |
| Orders / results / imaging | Local orders, specimen intake, typed panels, report corrections and versioned review with web UI | External delivery/ingestion, expanded specimen lifecycle, complete source mapping and validated FHIR resources |
| Prescriptions / eRx | Planned | Vendor/network integration, renewal/change/cancel workflows and applicable prescriber controls |
| Immunizations / public health | Planned | Products, CVX/MVX, lot/route/site, historical/administered distinctions, registries and reporting |
| Documents / forms / referrals | Planned | Object storage, malware controls, signed documents, structured forms, consent and referral lifecycle |
| Insurance / billing / claims | Native coverage and charge ledger; bounded 837P, delivery/acknowledgment, 835/PLB and multi-transaction correction workflows | Electronic eligibility, broader claim/payer profiles, enrollment and live acceptance, financial reporting/close, complete responsibility/secondary-payer workflows and production reconciliation |
| Messages / patient portal | Partial | Signed-record API only; messages, release policy, consent, patient onboarding and portal UI pending |
| Directories / reporting / CDR | Planned | Facilities/practitioners/organizations, clinical rules, quality/reporting and versioned terminology |

## Versioned standards baseline

FHIR R4 **4.0.1** is the initial interoperability foundation, using a fixed version
and the applicable ONC (g)(10) references. Start with explicit supported
resources and searches; do not advertise generic FHIR support before validation.
The initial `/fhir/metadata`, `/fhir/Patient` and `/fhir/Patient/{id}` routes
implement draft capability discovery and read-only native Patient search/read.
Searches cover name prefix, MRN, exact birthdate and ID, with keyset pagination.
This has not been validated against US Core or a formal FHIR validator.

- [FHIR R4 HTTP](https://hl7.org/fhir/R4/http.html): resource reads/searches, history,
  conditional updates, transaction behavior and OperationOutcome errors.
- [US Core 6.1.0](https://www.hl7.org/fhir/us/core/STU6.1/): a fixed USCDI v3 baseline
  supported by the certification ecosystem. This is not the latest published US
  Core; select an approved target rather than silently following the latest URL.
- [SMART App Launch 2.2.0](https://hl7.org/fhir/smart-app-launch/STU2.2/): evaluate
  this fixed target against the chosen ONC/SVAP test configuration. The current
  OAuth2 implementation is not SMART or OIDC.
- FHIR Bulk Data, patient and population scopes, discovery, backend-services
  authorization, consent and terminology validation must be implemented and tested
  alongside resource APIs. Select and pin the compatible Bulk Data release when
  configuring the interoperability milestone.

ONC's current [Inferno (g)(10) test kit](https://fhir.healthit.gov/test-kits/onc-certification-g10/)
reports version **8.0.7**, updated September 8, 2026. It covers SMART launches,
US Core profiles/searches, required data and references, and population exports.
It permits selected approved/SVAP standard versions. Pin the selected versions in
the future conformance test job; rerun after upgrades and retain machine-readable
results. Passing that suite alone is not certification of the whole EHR.

## ONC evidence workstreams

| Workstream | Initial evidence | Remaining acceptance work |
|---|---|---|
| Clinical documentation and patient demographics | Synthetic visit test | Complete specified data elements and clinical scenarios |
| CPOE medications, labs and imaging | Synthetic local laboratory/imaging/procedure order and result tests; no native prescribing | Complete specified data elements/lifecycle, external interfaces and medication prescribing; formal criterion-specific evidence |
| Medication/allergy/problem lists and reconciliation | Synthetic native list/status/review/revision and source-reconciliation tests | Complete standardized content, terminology, source-version semantics and formal criterion-specific evidence |
| Security, access and audit | Tenant/role tests, signed note/amendments, atomic audit | MFA, recovery, consent, granular policy, audit export, retention, session administration, vulnerability review and operational evidence |
| Patient access / export | Signed-record API | Verified identity mapping, patient UX, standardized downloads, EHI export and release policy |
| Standardized patient/population API (g)(10) | Draft CapabilityStatement; Patient read/search tenant tests | Complete required resources/searches and US Core, SMART and Bulk Data with pinned Inferno results |
| Transition/referral/document exchange | None | Structured exchange, reconciliation, transport and required vocabularies |
| Public health / quality / decision support | None | Determine applicable criteria and implement their explicit test procedures |
| Reliability and deployability | Local PostgreSQL workflow | Backup/restore drills, least-privilege runtime DB role, migration/rollback, observability without PHI, incident response and load testing |

Use the [ONC certification criteria](https://healthit.gov/certification-health-it/certification-criteria/)
and [current (g)(10) test method](https://healthit.gov/test-method/standardized-api-for-patient-and-population-services-acb-atl/)
as authoritative requirements. Each future requirement needs a criterion, selected
standard/version, implementation location, automated test and review evidence.
This table is a starting workstream map, not an exhaustive regulatory checklist.
