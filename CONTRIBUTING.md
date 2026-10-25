# Contributing to SunCharts EHR

SunCharts EHR is an independent Rust EHR and web interface under development.
Use synthetic data only. It is not certified or ready for clinical production.
See [the roadmap](docs/roadmap.md) and [release checklist](docs/release-checklist.md)
for the supported workflow scope and release evidence.

Read [AGENTS.md](AGENTS.md) and [the architecture](docs/architecture.md).
The engine/GUI use [AGPL-3.0-only](LICENSE); the API specification under `api/`
uses [Apache-2.0](api/LICENSE). Preserve the applicable notices. Submit only work
you have the right to contribute under the applicable project license. There is
no adopted contributor relicensing grant or commercial dual-license program.
Do not transfer proprietary source or third-party application implementation
into this repository without the necessary rights and compatible licensing. Public specifications/schema documentation can inform an
independent implementation; cite the source and pin the relevant version.

## Development and validation

Use the Rust and PostgreSQL setup in [README.md](README.md), a dedicated local
PostgreSQL 16+ database, and private environment variables. `.env.example` contains
variable names and development defaults; it is not a production configuration.
Do not commit credentials, real patients, production exports, provider tokens,
SSH private keys, screenshots of real charts or clinical logs.

Before submitting:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
TEST_DATABASE_URL=postgres://localhost/suncharts_ehr_test cargo test --locked
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/test_practice_ui.cjs
```

Set `TEST_DATABASE_URL` to a disposable database with permission to create test
schemas. The tests do not use your clinical database. The optional loopback SFTP
verification in `scripts/verify_provider_sftp.py` requires its documented local SSH
prerequisites; ordinary ignored tests are not proof that transport was exercised.
Also run `node --check` on changed web JavaScript. Test commands may require a
newer Rust toolchain than the package minimum; record the actual toolchain used.

Keep changes reviewable and include a concrete before/after behavior, validation
performed, remaining gaps and any external protocol/version assumptions. Test
state transitions, failure/rollback, permissions, tenant/patient isolation and
concurrent versions when the change affects them. A backend test does not establish
interactive visual acceptance or partner acceptance; label those separately.

Every clinical query must use the authenticated tenant. Every state change and
its audit event must commit together. Signed records, source evidence and history
must remain immutable; corrections append attributed revisions. Do not weaken
these controls to make a demo convenient. Never modify an already-applied migration;
add a sequential successor. Do not log secrets or patient content.

For API changes, update the Apache-2.0 contract, migration/workflow documentation
and evidence. For GUI changes, preserve patient context and unsaved clinical work,
show errors instead of fabricated empty data, and do not imply that an unsent
order or recorded payment was transmitted or collected.

Security issues require private handling. Read [SECURITY.md](SECURITY.md); do not
post sensitive vulnerability details, credentials or patient information publicly.
