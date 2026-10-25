# SunCharts EHR

[Source](https://github.com/PIndustries/suncharts-ehr) · [Developer preview](docs/releases/developer-preview.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

SunCharts EHR is an open-source, self-hosted electronic health record with a Rust
server, PostgreSQL storage and an included clinical web workspace. **SunCharts
Engine** powers the API. Clinics can run the web application independently;
optional SunCharts services and clients connect through HTTP APIs.

**Developer preview: use synthetic data only.** This release is not certified or
ready for clinical production. [The roadmap](docs/roadmap.md) describes current
capabilities and remaining work.

## What you can explore

- **Practice home:** daily patient flow, checked-in appointments, unfinished
  encounters and results awaiting acknowledgment, with links to the relevant chart.
- **Patient charts:** patient finder, clinical summaries, contact details,
  attributed contact revisions, recorded vitals and encounter history.
- **Scheduling:** day and seven-day agendas, provider filters, booking/rescheduling,
  arrival/cancel/no-show actions, provider blocks and encounter handoff.
- **Encounters:** appointment-linked visits, SOAP notes and vitals, signing,
  immutable signed content and attributed amendments.
- **Clinical lists:** problems, allergies and medication statements, explicit
  review states, versioned edits and source reconciliation. Medication statements
  record history; they do not provide electronic prescribing.
- **Orders and results:** local orders, specimen intake, typed result panels,
  report corrections, version-specific acknowledgment and a results inbox.
- **Revenue cycle:** payer and coverage records, encounter charges, account ledgers,
  recorded payments/adjustments, claim preparation and bounded 837P generation.
- **Remittances:** reviewed 835 import, provider adjustments, correction/reversal
  chains and atomic multi-transaction file posting or undo.
- **Connected applications:** scoped per-user OAuth2 grants and durable change
  notices. An installation connection does not start data streaming automatically.
- **Source import:** staged archival records, reconciliation and explicit native
  mappings that preserve the original evidence. Production cutover remains disabled.

External provider adapters require operator configuration and enrollment. Local
protocol and accounting tests do not establish live provider acceptance. Recording
a payment does not collect funds; placing a local order does not transmit it.

## Run locally

Use Rust 1.89+, PostgreSQL 16+, Python 3 and a native C build toolchain, including
CMake where required by AWS-LC. Node 22+ runs the UI fixture tests. Create a
dedicated development database and export the settings in [.env.example](.env.example).
The binary reads process environment variables; it does not load a dotenv file.

```sh
createdb suncharts_ehr_dev
export ENGINE_DATABASE_URL=postgres://localhost/suncharts_ehr_dev
export ENGINE_BIND=127.0.0.1:8090
export ENGINE_PUBLIC_URL=http://127.0.0.1:8090
export ENGINE_BOOTSTRAP_EMAIL=clinician@example.test
export ENGINE_BOOTSTRAP_TENANT_ID="$(uuidgen)"
export ENGINE_BOOTSTRAP_CLINICIAN_ID="$(uuidgen)"
export ENGINE_BOOTSTRAP_PASSWORD="$(python3 -c 'import getpass; print(getpass.getpass("Development password (14+ characters): "))')"
cargo run --locked
```

Open [localhost:8090](http://127.0.0.1:8090/). Bootstrap creates an owner account
once; restarting does not reset its password or identity. Keep the tenant and
clinician UUIDs stable for this installation. Use different UUIDs and credentials
for a separate synthetic clinic. Full staff administration, account recovery and
MFA remain development work; use a controlled local environment.

## Data and access controls

Tenant identity comes from authenticated sessions or scoped per-user OAuth2 grants.
Writes and audit events commit together. Versioned updates require the current
quoted `If-Match`; stale writers receive a conflict. Signed records, revisions,
source evidence and ledger history have database immutability protections.
These controls do not make records tamper-proof against a database administrator.

The browser uses opaque HttpOnly/SameSite=Strict session cookies, marked Secure
over HTTPS. Cookie-authenticated mutations require the configured Origin.
Clinical responses are `no-store`; browser chart data and tokens are not stored
in localStorage. Staff roles further restrict actions.

Owners register connected applications with exact callbacks. Authorization code
with S256 PKCE, short-lived opaque access tokens, rotating refresh tokens and
revocable grants support independent installations. Discovery is available at
`/.well-known/oauth-authorization-server`. This OAuth2 implementation is not
SMART or OIDC. The development HS256 gateway is disabled by default.

## API and source

- `/openapi.json` — the Apache-2.0 API specification.
- `/source` — the source archive embedded at build time, including build materials,
  web assets, migrations and documentation. Rebuild it when modifying a distribution.
- `/health` — process liveness, not database readiness.
- `/fhir/metadata`, `/fhir/Patient`, `/fhir/Patient/{id}` — initial read-only FHIR R4
  Patient discovery/search/read; broader resources and conformance remain pending.

See [architecture](docs/architecture.md), [standards](docs/standards.md),
[patient details](docs/patient-demographics.md), [scheduling](docs/scheduling.md),
[clinical lists](docs/clinical-lists.md), [orders/results](docs/orders-labs-results.md),
[billing](docs/billing-insurance.md), [claims/remittances](docs/claims-remittances.md),
[835 file workflows](docs/era-files-corrections.md) and [migration](docs/migration.md)
for the supported contracts and their limits.

## Development checks

Use a disposable PostgreSQL database; tests create isolated schemas.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
TEST_DATABASE_URL=postgres://localhost/suncharts_ehr_test cargo test --locked
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/test_practice_ui.cjs
```

[Contribution guidance](CONTRIBUTING.md) explains test prerequisites and change
requirements. [Verification](docs/verification.md) distinguishes automated checks,
interactive UI acceptance and external acceptance. Passing local tests does not
establish clinical production readiness.

## Current development boundaries

Work remains on staff administration and care-team permissions, richer registration,
prescribing, external clinical interfaces, attachments, patient communication and
release workflows, terminology validation, reporting, production migration,
backup/restore operations and security hardening. Some worklists are bounded;
large-history pagination remains necessary. FHIR profile validation, SMART, Bulk
Data and formal certification have not been completed.

The [roadmap](docs/roadmap.md), [release notes](docs/releases/developer-preview.md)
and [release checklist](docs/release-checklist.md) document these boundaries.
Public source availability is a developer milestone, separate from clinical use.

## License

Copyright 2026 P Industries. The server and included web interface are
**AGPL-3.0-only** under [LICENSE](LICENSE). The API specification under `api/` is
**Apache-2.0** under [api/LICENSE](api/LICENSE). See [licensing](docs/licensing.md)
for source-offer and independent-client considerations.
