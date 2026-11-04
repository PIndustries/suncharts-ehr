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
should use `/health` for liveness and `/ready` for readiness.

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
`request_id` is the idempotency identity and `image_reference` is always a digest. A retry must reconcile the same
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
