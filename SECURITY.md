# Security policy

SunCharts EHR is under development. No release is designated for clinical
production or real patient data. There is no supported-release or guaranteed
security response schedule yet.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/PIndustries/suncharts-ehr/security/advisories)
and choose **Report a vulnerability**. Do not post sensitive details in a public
issue or pull request. GitHub documents the process in its
[reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Provide a minimal synthetic reproduction, affected version and expected versus
actual behavior. Do not include patient data, production exports, credentials or
access tokens. Do not test a clinic or provider account without its operator's
authorization.

Tenant isolation, authorization, signatures, audit/history integrity, credential
storage and the corresponding source archive are within scope. Maintain deployment
and dependency protections independently of this reporting process.
