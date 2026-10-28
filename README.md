# SunCharts EHR

A self-hosted electronic health record built with Rust and PostgreSQL, with an
included web workspace. It runs independently; SunCharts services and native
clients connect through its HTTP API.

**Under development. Use synthetic data only.** The project is not certified or
ready for clinical production. See the [roadmap](docs/roadmap.md) for missing work.

## Features

- Patient charts, contact details, problems, allergies, medications and surgical/dental histories.
- Provider calendars, recurring appointments, rescheduling and email reminders.
- Nurse/MA intake and vitals, clinician SOAP notes, signatures and amendments.
- Local orders and results, patient documents, referrals, checkout, after-visit summaries and follow-up tasks.
- Insurance, charges, professional claims, clearinghouse connections and remittances.
- Staff administration, provider profiles, facilities and rooms.
- Local prescription preparation, safety-review attestations, authorization and print handoff.
- A separate patient portal for released visit summaries, appointment requests and secure messages.
- OAuth2 connections, clinical/document FHIR reads and bounded native clinical writes.

Prescription authorization is local: electronic pharmacy transmission and EPCS are
not implemented. Medication statements remain separate from prescriptions. Local
orders do not transmit to a laboratory, and payment collection supports test mode only.

## Run locally

Install Rust (declared minimum 1.89), PostgreSQL 16+ and a C build toolchain with CMake. Python 3
supports import tools; Node 22+ runs frontend tests. Settings come from process
environment variables; the server does not load a dotenv file.

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
once; restarting does not reset it. Keep installation UUIDs stable. Review
[.env.example](.env.example) and [operations](docs/operations.md) before changing
storage, keys or the public address.

## Documentation

| Guide | Contents |
|---|---|
| [Clinical workflow](docs/clinical.md) | Registration, chart review, rooming, notes, results and checkout |
| [Scheduling](docs/scheduling.md) | Calendars, conflicts, recurring visits and reminders |
| [Billing](docs/billing.md) | Coverage, charges, claims, ERA posting and test payments |
| [Clearinghouses](docs/clearinghouses.md) | Claim.MD setup, HTTP/SFTP adapters and retrieval |
| [Connected services](docs/integrations.md) | OAuth onboarding, managed reminders and support |
| [API](docs/api.md) | Authentication, concurrency, FHIR and the OpenAPI contract |
| [Migration](docs/migration.md) | Source exports, staged import and reconciliation |
| [Operations](docs/operations.md) | Staff, credentials, backups, builds and releases |
| [Architecture](docs/architecture.md) | Service layout and data boundaries |
| [Roadmap](docs/roadmap.md) | Current gaps and development priorities |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

The server and web interface are **AGPL-3.0-only**; see [LICENSE](LICENSE).
The API specification is **Apache-2.0**; see [api/LICENSE](api/LICENSE).
The running application offers its build-time source at `/source`.
