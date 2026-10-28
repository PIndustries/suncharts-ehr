# Roadmap

SunCharts EHR currently supports a development workflow from registration and
scheduling through delegated rooming, clinician documentation, local orders,
checkout and billing. Features have different levels of depth; a screen or API
route is not evidence of a complete practice workflow.

## Next clinical work

- Expand registration, patient matching/merge and proxy relationships.
- Add diagnosis lookup/edition validation and structured post-signing diagnosis
  corrections; expand the existing explicit order and charge diagnosis links.
- Add reusable note templates and richer histories/exams.
- Expand existing patient documents and referral coordination with consent/forms,
  electronic delivery, receipt tracking and external outcome reconciliation.
- Expand the patient portal with identity proofing, recovery/MFA, guardians and
  broader clinician-controlled results/document release.
- Connect local prescription orders to enrolled eRx networks, EPCS, medication
  safety services, refill messages and dispensing reconciliation.
- Expand documented immunizations with validated vaccine catalogs, forecasting,
  inventory and enrolled registry exchange.
- Expand results follow-up, escalation, general staff inbox and specialty workflows.

## Practice and revenue cycle

- Working-hours templates, available-slot search, waitlists and patient booking.
- Expanded staff permissions, invitations, recovery and MFA.
- Electronic eligibility, fee schedules, responsibility allocation and statements.
- Secondary/tertiary billing, broader claim profiles, denials/appeals and financial close.
- Live payment collection and payout/dispute reconciliation.
- Enrolled clinical/financial partner testing with retained acceptance evidence.

## Interoperability and operations

- Complete required clinical resources, field semantics, searches and profile validation.
- SMART/OIDC, Bulk Data, standardized clinical/document exchange and EHI exports.
- A complete migration rehearsal with reconciliation, restore and rollback evidence.
- Clinical usability, accessibility, performance, security and deployment acceptance.
- Separately scoped standards and certification requirements with selected versions
  and formal assessment results.

The [API guide](api.md) describes implemented FHIR behavior. The
[migration guide](migration.md) explains why production cutover remains blocked.
There is no overall completion percentage or certification claim.
