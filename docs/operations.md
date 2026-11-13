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

`/ready` verifies that the process can query PostgreSQL. Container orchestrators
should use `/health` for liveness and `/ready` for infrastructure readiness. Its
JSON response reports `infrastructure_ready`, `connection_status`, `connected`,
`managed_email_ready`, `support_ready` and overall `ready` separately. A hosted
instance can serve its web workspace while its outbound Connect channel is still
connecting; that does not mean managed services are ready.
`document_store` reports where new patient files are kept (`mode`) and, when that
is file storage, whether it answered its last check (`reachable`, refreshed in the
background at most every 30 seconds, so the probe never waits on the store). It is
informational: an unreachable file store does not make the server unready. See [Patient file storage](#patient-file-storage).

## Container deployment foundation

The root [Dockerfile](../Dockerfile) builds a non-root image. The example
[Compose stack](../deploy/compose.yaml) binds the application only to loopback,
waits for PostgreSQL, mounts the provider master key on persistent storage and
passes database/bootstrap values through secret files. Put an HTTPS reverse proxy
in front of it and set `ENGINE_PUBLIC_URL` to that exact origin.

The image workflow publishes `ghcr.io/pindustries/suncharts-ehr:sha-<40-character
commit>` for `main`, version tags and explicit workflow runs. The provisioning
input is the digest-qualified reference written to the workflow's
`image-reference.txt` artifact, never the tag alone. The Dockerfile pins both
builder and runtime base images by multi-platform digest; `Cargo.lock`,
`BUILD_VERSION`, the Git commit and those base digests are the immutable build
inputs. The workflow publishes an SBOM, provenance and `build-inputs.sha256`. It
also resolves build packages from the pinned Debian snapshot declared in the
Dockerfile. It does not deploy an EHR.

Public community notifications are optional. Set the repository Actions secret
`DISCORD_COMMUNITY_WEBHOOK_URL` to report tagged releases, explicitly dispatched
image publications and their failures. Scheduled images and ordinary CI stay
silent. A merged pull request is reported only when maintainers apply the
`community-update` label. If the secret is absent, notification steps are skipped.

For dev Kubernetes, render [the runtime template](../deploy/kubernetes/runtime.template.yaml)
from a validated provisioning request:

```sh
python3 deploy/render_kubernetes.py request.json --output runtime.yaml
kubectl apply --server-side --field-manager=suncharts-connect -f runtime.yaml
```

The request must contain the GHCR image by digest. The renderer derives a stable
tenant namespace and emits PostgreSQL, persistent database and provider-key
storage, a single Recreate-strategy EHR deployment, Services, restricted pod
security, default-deny network policy and a cert-manager/nginx Ingress. Cluster
prerequisites are ingress-nginx, cert-manager with the selected staging issuer,
working wildcard DNS and a default `ReadWriteOnce` storage class. Dev readiness
requires the PostgreSQL StatefulSet, EHR `/ready`, Ingress address and TLS secret;
the checked-in manifest alone is not a running instance.

Before applying, the provisioner creates two namespace-local Secrets without
logging their values:

- `suncharts-ehr-database`: `postgres_password` and `engine_database_url` (the
  latter uses the in-namespace `postgres:5432` Service).
- `suncharts-ehr-bootstrap`: `bootstrap_password`, 14–1024 bytes, delivered to
  the owner through an out-of-band secure channel.
- `suncharts-ehr-connect-bootstrap`: `managed_connect_bootstrap.json`, a
  short-lived capability bound to one paid or explicitly admin-activated hosted
  order, tenant, owner and HTTPS hostname. The EHR exchanges it outbound with
  Connect once and erases the capability from process memory. The raw capability
  must never enter rendered/logged YAML, a URL, or browser storage.

Managed upgrades do not rewrite that bootstrap provenance. The dev release executor adds a
separate `managed_release_selection.json` key to the same mounted Secret. Its versioned contract
names the immutable release digest, installation, release, predecessor selection and rollout or
rollback reason. The EHR validates it against the running image/build and records an append-only
selection chain. Older managed installations without this key continue to use their original
bootstrap version and digest as the active selection.

The runtime mounts those values as files. The provisioner generates them, the
stable tenant/clinician UUIDs and the hostname exactly once per `request_id`.
Retries reconcile the same namespace and digest. After initial owner creation,
remove the bootstrap secret and its Deployment references; do not rotate the
tenant identity or persistent provider master key during a retry or upgrade.

The Compose file is a deployment foundation, not production acceptance. Before
using real data, supply externally backed PostgreSQL and credential backups,
monitoring, restore drills, network policy and an independently reviewed secret
manager. After the first owner exists, remove the bootstrap password secret from
the long-running service configuration; stable tenant and clinician UUIDs must
not change.

Managed provisioners exchange only the identifiers and owner email described by
[`provisioning-request.schema.json`](../deploy/provisioning-request.schema.json)
and [`provisioning-result.schema.json`](../deploy/provisioning-result.schema.json).
`request_id` is the idempotency identity. Initial `expected_version` and `image_reference` bind
the immutable bootstrap release to its digest. Later approved selections are kept separately;
`/ready` reports bootstrap, selected and observed values and Connect waits for exact selected to
observed equality.
A retry must reconcile the same
deployment, never create another instance. Passwords, API keys, database URLs and
patient information are outside this contract and must use the provisioner's
secret store. A `ready` result requires the assigned HTTPS URL and successful
readiness check; accepting a request is not proof that an EHR is available.

## Hosted release control

Publishing and rollout are separate gates. For a version tag matching
`v<BUILD_VERSION>`, the image workflow publishes a commit-addressed image, creates
GitHub provenance attestations for the image and release manifest, and attaches
the manifest, digest and build-input checksums to an already-created GitHub
Release. It never substitutes a mutable tag for the digest. Connect must verify
the GitHub attestation, repository, workflow identity, source tag/commit and
release asset checksums before an administrator can approve the release.

Every merge to `main` also publishes a dev preview through a separate workflow
(`publish-dev-preview.yml`) that does not wait for the full regression. A dev
preview is never a production release: its manifest uses contract
`dev-preview-1` (`deploy/dev-preview-manifest.schema.json`), names no source
tag, is eligible for the `dev` channel only and states
`production_eligible: false`; its assets are attached to a `dev-<short commit>`
prerelease, its image tag is `dev-sha-<commit>`, and its attestations are signed
by the dev preview workflow on `refs/heads/main` rather than by the image
workflow on a version tag. Production verification must keep rejecting all of
these.

Approval assigns a supported release to one or both channels:

- **preview** — administrator-selected installations or cohorts only;
- **stable** — the default only after preview acceptance and explicit promotion;
- **pinned** — a supported approved version selected for one installation, not an
  arbitrary tag or digest.

The per-installation contract is
[`installation-release-state.schema.json`](../deploy/installation-release-state.schema.json).
Connect owns `current`, `desired` and `last_known_good` identities. Partners may
schedule an update or choose among releases that a platform administrator has
already approved and kept supported. Partners cannot publish, promote, re-enable
blocked releases, select unapproved digests or override a global security update.
Platform administrators control global promotion, pause/block, cohort membership,
rollout percentage, maintenance deadlines and emergency rollback.

Every update attempt must follow this order:

1. Verify the signed release and confirm the current database revision is within
   its declared upgrade range.
2. Create and verify a pre-update PostgreSQL backup plus a separately protected
   copy/reference for the provider master key. Record the backup identity before
   changing `desired` or the running image.
3. Apply the desired digest and retain `last_known_good`. A browser return,
   scheduled time or created Pod is not success.
4. Health-gate the rollout: `/version` must report the desired build, `/ready`
   must query PostgreSQL, `/health` must remain live, and the Ingress/TLS endpoint
   must pass for the administrator-defined acceptance window.
5. Promote `current` only after the gate. On failure, automatically return to
   `last_known_good`. If the schema revision changed, restore the pre-update
   database backup before the old image; SQLx migrations are forward-only and an
   in-place database downgrade is never assumed safe.

[`release-metadata.json`](../deploy/release-metadata.json) must match the highest
checked-in migration. The release workflow refuses drift. A same-schema image
may declare image-only rollback; this release currently requires backup restore
for a database rollback. Backup creation alone is insufficient—restore testing,
retention and key recovery remain operator responsibilities.

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

## Patient file storage

Uploaded patient files (original uploads and later file versions) are kept in
PostgreSQL by default. They can instead be kept in S3-compatible object storage.
Document details, history, hashes and audit events always stay in PostgreSQL;
only the file bytes move.

### Settings

All are optional. With none set, nothing changes for an existing installation.

| Setting | Meaning |
| --- | --- |
| `ENGINE_DOCUMENT_STORE` | `database` (default) or `s3`. Where **new** files are written. |
| `ENGINE_DOCUMENT_S3_ENDPOINT` | `http(s)://host[:port]`, no path. Path-style addressing is always used. |
| `ENGINE_DOCUMENT_S3_REGION` | Signing region, for example `us-east-1`. |
| `ENGINE_DOCUMENT_S3_BUCKET` | An existing bucket. The server never creates one. |
| `ENGINE_DOCUMENT_S3_ACCESS_KEY_FILE` | Path of a file holding the access key. |
| `ENGINE_DOCUMENT_S3_SECRET_KEY_FILE` | Path of a file holding the secret key. |

With `ENGINE_DOCUMENT_STORE=s3` the server refuses to start if any setting is
missing, a key file is unreadable or empty, the credential master key is
unavailable, or the bucket does not answer a signed `HEAD` request. The log line
names the setting at fault and never prints a value. After startup a brief outage
does not stop the server: uploads and reads of stored files return HTTP 503 with
a plain "temporarily unavailable" message, nothing is written, and they work
again when the store returns. Files still in PostgreSQL stay readable throughout.

The access key needs, on that one bucket only, permission to get and put
objects and to list the bucket (on AWS-style policies `s3:GetObject`,
`s3:PutObject` and `s3:ListBucket`; the bucket check and "does this object exist"
answers depend on the last one). It does not need delete permission, and
withholding it is recommended.

Each row records where its own file is, so a database holding some files in
PostgreSQL and some in object storage works at all times. If `s3` is later
removed from the settings while files are stored there, the server still starts
(with a warning) and those files answer 503 until the setting is restored.

### Encryption and integrity

The application encrypts every file before upload with AES-256-GCM, a fresh
random 96-bit nonce per object, and a key derived (HKDF-SHA-256) for each practice
from the credential master key described under
[Credentials and backups](#credentials-and-backups). The object store only ever
receives ciphertext. Each object is bound to its practice, document and file
version, so an object copied over another one fails to decrypt.

After every decrypt the file is compared with the SHA-256 and size recorded in
PostgreSQL at upload. On any mismatch no bytes are returned, the request answers
HTTP 500 with an integrity message, and a line naming the object is logged.

**The credential master key is now required to read patient files. Losing it makes
every stored file unrecoverable.** With `s3` selected the key is created only on
an installation that has nothing depending on it yet; once files or credentials
depend on it, a missing key stops startup instead of being replaced.

### Objects are write-once and never deleted

Object names are `t/{practice id}/d/{document id}/v{file version}-{sha256}`. They
contain no patient identifier and no file name. The application never deletes an
object and never writes over one that exists; if an object is already present
under a name it is read back and must verify before it is used. An upload whose
database write fails can leave an unreferenced object behind. That is harmless
(nothing points to it), it is logged, and it is never cleaned up automatically.
Do not add lifecycle or expiry rules to the bucket.

### Moving existing files

Selecting `s3` affects new files only. Existing files stay in PostgreSQL until
an owner starts the move. Nothing moves at startup or on a schedule.

1. Take a PostgreSQL backup and confirm the master key backup is current.
2. Set the `ENGINE_DOCUMENT_*` settings and restart. Confirm the startup line
   `Patient file storage: new files are kept in encrypted file storage`.
3. As an owner open **Practice administration**, **Workspace**, **File storage**
   and choose **Move files to file storage**. The page calls
   `POST /api/v1/practice/document-storage/move` repeatedly and shows progress.
   Each call handles up to 25 files or 200 MiB of that practice's files.
4. It is finished when the panel shows no files left in the practice database
   (`GET /api/v1/practice/document-storage` reports `files.database.count` 0).

For each file the server encrypts and uploads it, downloads it again, decrypts
it and compares hash and size with the database row. Only then, in one
transaction with an audit event (`practice.document_storage.moved`), does the
row switch to object storage and release its bytes. A file that fails any check
stays in PostgreSQL untouched and is listed in the response under `failed`.
The move can be stopped, repeated and run from more than one browser at once;
staff can keep working while it runs. Each practice (tenant) is moved by its own
owner.

The move is one way. The database rejects moving a file back, changing where a
row points, or changing a file's recorded hash. PostgreSQL does not shrink on
disk until the table is vacuumed; reclaiming the space with `VACUUM FULL` needs
a maintenance window and is optional.

### Backups and rollback

- Back up **three** things: PostgreSQL, the credential master key, and the
  bucket. A database backup alone no longer contains the files that were moved
  or uploaded after `s3` was selected.
- Because objects are write-once and never deleted, any earlier database backup
  can still read every object it refers to. Restoring a database backup taken
  before a move simply shows those files in PostgreSQL again.
- Use the object store's own replication or versioned backup for the bucket.
  Restore tests must cover a stored file opening correctly, not only row counts.
- A release older than schema 106 cannot read files that are in object storage.
  After the first file is stored there, roll back by restoring the pre-update
  database backup, not by running an older image against the newer database.
- Rotating the master key is not implemented; rotating the S3 access key is a
  key file change and a restart.

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
