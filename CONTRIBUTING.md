# Contributing

Read [README.md](README.md), [AGENTS.md](AGENTS.md) and the
[architecture guide](docs/architecture.md) before changing the engine.
Use synthetic patients and dedicated development databases. Never commit credentials,
clinical exports, private keys or screenshots containing real patient information.

## Checks

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database with permission to
create isolated test schemas. Do not point tests at an installation database.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
TEST_DATABASE_URL=postgres://localhost/suncharts_ehr_test cargo test --locked
python3 -m unittest discover -s scripts -p 'test_*.py'
for test_file in scripts/test_*ui.cjs scripts/test_chart_scheduling.cjs scripts/test_schedule_calendar.cjs scripts/test_week_calendar.cjs; do
  node "$test_file" || exit 1
done
for source_file in web/*.js; do node --check "$source_file" || exit 1; done
```

The three optional SSH tests require a provisioned loopback fixture. See
`scripts/verify_provider_sftp.py` for its prerequisites. Do not report skipped
transport tests as successful provider validation.

## Changes

Local development and test builds omit debug symbols and incremental caches to
limit storage. For a debugger session, explicitly set
`CARGO_PROFILE_DEV_DEBUG=2`; restore the default afterwards.

`python3 scripts/clean_build_cache.py --project "$PWD"` previews cache maintenance;
add `--apply` to remove idle compiler caches older than seven days, over the
8 GiB budget, or when available disk space is below 15 GiB. Cargo-locked profiles
are skipped. Built application executables, source, settings and data are retained.
The budget applies to idle caches, not to an active build's peak disk usage.

Keep pull requests focused. Explain the behavior changed, the reason for it and
how it was tested. Include relevant failure cases and remaining limitations.
Update [api/openapi.json](api/openapi.json) when an HTTP contract changes.

Clinical queries must use the authenticated tenant. Writes and audit events must
commit together. Preserve signed content and history; corrections append records.
Test permissions, stale versions, concurrency and rollback where they affect the
change. Never edit an applied migration; add a sequential successor.

For web changes, exercise the affected workflow in a browser as well as running
fixtures. Preserve patient context and unsaved work, and show failures explicitly.
A local order is not a transmitted order; a recorded payment is not a collection.

Documentation should explain installation, operation or a supported contract.
Keep commands and limits current. Avoid duplicate API payload catalogs, development
diaries, per-build test reports, speculative completion percentages and unverified
release claims. Keep internal engineering notes outside the public source tree.

## Licensing and security

Submit only code you can contribute under the applicable project license:
AGPL-3.0-only for the implementation, Apache-2.0 for `api/`. Preserve notices.
Do not copy proprietary or incompatible third-party implementation code.
Cite versioned public specifications when implementing an external protocol.
No contributor relicensing grant or commercial dual-license program is adopted.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
