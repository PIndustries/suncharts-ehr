# SunCharts Engine

Standalone clinical service. Engine source is AGPL-3.0-only; files under api/ are
Apache-2.0. Do not copy proprietary source or third-party application code here
without the necessary rights and compatible licensing.
Clients communicate through HTTP; do not link this crate into proprietary apps.
Use synthetic data only. Every clinical query must scope by trusted tenant and
every state mutation and its audit event must commit atomically. Signed note
content is immutable; corrections append attributed amendments. Never log JWTs,
patient content, database URLs or credentials. Run cargo fmt --check,
cargo clippy --all-targets -- -D warnings, and the PostgreSQL integration tests.
Keep existing integrations operational in the separate SunCharts application repository.
No deployment, public publication or production-data migration is part of bootstrap.

Public documentation should explain setup, operation or supported contracts.
Update the existing handbook instead of adding milestone diaries, per-build test
reports or duplicate capability matrices. Keep internal engineering notes outside
the repository and its corresponding-source archive. Preserve accurate limitations.

Keep compact dev/test profiles enabled. After large local validation runs, apply
`scripts/clean_build_cache.py --project "$PWD" --apply`; never delete active Cargo
caches, application executables, credentials or databases to reclaim build space.
