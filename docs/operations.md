# Operations

Use the [local setup](../README.md#run-locally) and [.env.example](../.env.example)
for a development installation. Keep real patient data out of this release.

## Installation settings

`ENGINE_DATABASE_URL` selects PostgreSQL. `ENGINE_BIND` defaults to loopback port
8090. `ENGINE_PUBLIC_URL` is the browser origin and OAuth issuer/callback base; set
it to the installation's HTTPS origin when using a reverse proxy. Cookies and
Origin checks remain enforced. Cloud onboarding requires an externally reachable
HTTPS address; loopback alone is insufficient.

Bootstrap variables create the first owner once. Remove the bootstrap password
from the runtime environment after setup. They do not reset an existing account.
Do not use development defaults as a production deployment recipe.

`/health` reports process liveness, not database readiness. The server applies
schema migrations at startup. Back up before upgrading and never edit applied
migration files.

## Staff and location administration

An owner opens **Practice administration** to create local staff accounts, choose
roles, disable/reactivate access and maintain provider/facility/room directories.
Staff creation needs a unique sign-in email and an initial password of at least
14 bytes. Deliver initial credentials securely. Invitations, forced first-login
changes, self-service recovery and MFA are not implemented.

Role/access changes and password resets revoke existing sessions and OAuth grants.
The last enabled owner cannot be disabled or demoted. Provider profiles require an
enabled owner/clinician identity. Re-enabling a staff account does not reactivate
an old provider profile automatically. NPI checks validate format/checksum, not
licensure or enrollment.

Active rooms require an active parent facility. Deactivate rooms before their
facility. Rename/move operations are blocked when future bookings use the existing
location identity. Existing appointment text is retained. Directory entries do
not define working hours or equipment capacity. Lists are bounded; the UI indicates
when only part of a directory is loaded.

## Credentials and backups

Clearinghouse, payment and reminder credentials are encrypted with a private
32-byte master key. Its default path is `.suncharts/provider-master.key`;
`ENGINE_CREDENTIAL_KEY_FILE` can select another path. The key must be a regular,
owner-only file (0600 on Unix), in a private directory.

**Back up both PostgreSQL and the original master key, separately with appropriate
access controls. A database backup alone cannot recover credentials.** Mount the
key on persistent storage in containers. Never commit it, place it under a web
root or expose it in logs.

If the key is missing, incorrect or damaged, restore the original. The engine
holds credential-dependent operations rather than silently replacing the key.
Master-key rotation and a recovery UI are not implemented.

Test restoration into an isolated environment before relying on backups. Restore
and upgrade drills, monitoring, performance testing and independent security review
remain operational work; passing application tests does not establish them.

## Builds and releases

`BUILD_VERSION` uses `YY.MM.DD.BUILD`; increment the final number for another build
on the same date. The login screen, sidebar and footer display the compiled value.
The API contract has a separate version.

The binary embeds corresponding source at build time and serves it at `/source`.
Rebuild after source, web or documentation changes. Check the archive against the
intended distribution, including required build scripts. Runtime keys, environment
files, clinical data and internal engineering notes must stay outside it.

Before a release, run [the contributor checks](../CONTRIBUTING.md#checks), review
the affected workflows in a browser, scan the intended source/history for secrets,
verify licenses and the private security-reporting channel, and check hosted CI
for the exact release commit. Publish release notes and checksums for that version;
local test reports do not belong in the public handbook.

The implementation license is [AGPL-3.0-only](../LICENSE); the API specification
uses [Apache-2.0](../api/LICENSE). Preserve notices and the source link in modified
distributions. Consult the license texts for their terms.
