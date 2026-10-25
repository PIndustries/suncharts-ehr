# Security policy — development preview

SunCharts EHR is a synthetic-data development preview. No release is designated
for clinical production or real patient data. Passing local tests is not a security
assessment, certification or promise that a deployment is safe for clinical use.

## Report a vulnerability privately

Use the repository’s [Security → Advisories page](https://github.com/PIndustries/suncharts-ehr/security/advisories)
and choose **Report a vulnerability**. GitHub private vulnerability reporting was
enabled and verified through the repository API on October 25, 2026. Reports are
private to the reporter and repository maintainers; a GitHub account is required.
Do not use a public issue or pull request for sensitive vulnerability details.

Use a synthetic reproduction. Do not include real patient data, production exports,
provider credentials or access tokens. This preview has no guaranteed response or
patch-service timetable. Repository administrators should keep their security
notifications enabled and maintain this policy as supported releases develop.
See [GitHub’s reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
and the [release checklist](docs/release-checklist.md).

## Scope and disclosure

Use synthetic reproductions and the minimum information needed to demonstrate an
issue. Tenant/patient isolation, authorization, audit integrity, immutable signed
records, source archives and credential handling are security-sensitive boundaries.
Do not test against a clinic, production patient records or provider accounts
without the operator's explicit authorization.

There is currently no defined supported-release/patch-service schedule. Maintainers should publish supported versions and update these instructions
when a supported release and patch-service schedule exist.
