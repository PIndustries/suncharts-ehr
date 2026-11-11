# Integrations and optional connected services

The self-hosted EHR works independently. Practice-owned integrations run in the
EHR installation and store their encrypted credentials there. Connecting a
practice to SunCharts adds only the managed services and client access that the
practice explicitly enables.

## What runs where

| Capability | Instance-local EHR | SunCharts Connect |
|---|---|---|
| Clinical and administrative REST API | Yes; the installation is authoritative | Optional OAuth client access within the user's local permissions |
| FHIR R4 | Yes; bounded reads and writes at the installation's `/fhir` base | Not required and not a replacement FHIR server |
| Calendars and delegated scheduling API | Yes; includes availability, holds, bookings, changes and signed outbound scheduling webhooks | Optional managed appointment email |
| Billing, claims and clearinghouses | Yes; local ledgers, X12 workflows and clinic-configured adapters | Optional SunCharts Payments broker for supported Stripe Connect workflows |
| RingCentral, Gmail, Claim.MD, own Resend and AI providers | Clinic-owned credentials are encrypted in the installation; provider callbacks return to the installation | Does not store or supply those clinic-owned credentials |
| Support, managed reminders, native-client ecosystem and hosted-installation operations | Not part of the independent core service | Optional connected services |

FHIR is the implemented HL7-family API boundary. It is a bounded, instance-local
FHIR R4 surface, not a US Core certification, SMART App Launch implementation or
Bulk Data endpoint. A general HL7 v2 interface engine and ADT/SIU/ORU message
listeners are not currently included. The installation's `/fhir/metadata`
CapabilityStatement is the authoritative interaction list for that installation.
Provider webhooks and scheduling webhooks are narrow,
signed interfaces; they do not turn the EHR into a general-purpose relay or allow
an integration to bypass tenant, role, consent or review checks. See the
[API capability boundary](api.md#capability-and-service-boundary) and exact
[OpenAPI contract](../api/openapi.json).

## Connect to SunCharts

1. Configure the EHR address staff use in their browser. It can remain private. Allow the EHR server to make outbound HTTPS/WebSocket connections to `connect.suncharts.app` on port 443. Use HTTPS for staff browser access outside localhost; it does not need to be publicly reachable.
2. Open **Connected apps → Connect to SunCharts**.
3. Sign in at `connect.suncharts.app`, choose the owning practice and approve the connection.

Existing authorized installations keep their stored credentials. The former official host remains accepted for legacy callbacks and in-progress connection attempts; new setup and outbound connections use SunCharts Connect. No inbound port or new public EHR address is required.
4. Return to the EHR and review its connection status and available services.

There are no client IDs, secrets or service tokens to copy in this flow. Setup
uses authorization codes, PKCE, exact callback addresses and the original owner
session. Credentials are exchanged server-to-server and encrypted locally. The EHR initiates a TLS WebSocket; SunCharts does not make an inbound connection to the installation. The browser completing approval must still be able to reach its EHR address.

The connection includes supported clinical, billing, event and import access,
subject to the signed-in user's permissions. It does not migrate records or imply
that every workflow synchronizes automatically. Each person authorizes their own
account. Patient app identity mapping remains separate work.

Interrupted setup can be continued or cancelled from Connected apps. Configuration
changes during setup require a fresh connection. A new sender uses managed email;
an existing own-Resend sender keeps its configuration.

## Status

| Badge | Meaning |
|---|---|
| Not connected | No completed active connection |
| Access authorized | OAuth access exists on a connection using the earlier direct transport |
| Connected | An active clinical OAuth grant and a fresh, acknowledged outbound connection |
| Reconnecting | The outbound channel is being restored |
| Offline | No fresh outbound connection is available |
| Needs attention | Authorization or service verification needs review |

The badge receives a session-authenticated live health feed, updated within two seconds of local state changes. Channel heartbeats run every 15 seconds and expire after 45 seconds without a verified response. A minute-based HTTP refresh remains as a fallback. **Refresh connection status** also checks managed services separately. Their availability depends on the practice's service entitlement; a green channel does not imply every record is synchronized.

OAuth discovery, code exchange, refresh, revocation and permitted clinical API requests travel over the channel. Each clinical request retains its user OAuth token and passes the EHR's ordinary tenant, scope and role checks. Pending enrollment credentials cannot authorize clinical reads. The channel accepts bounded API messages, not arbitrary URLs or a general network tunnel. Messages are limited to 2 MiB; larger document transfers are not supported through this transport.

Clinical change feeds resume from durable event cursors. An interrupted mutation is never automatically replayed: its outcome may be unknown, so read the record before deciding whether to retry. Existing direct-HTTPS connections continue to use their original transport and five-minute managed-service freshness check.

## Reminders and support

Managed appointment email uses the same consent, contact verification and durable
recovery rules as an own-account sender. See [scheduling](scheduling.md). Acceptance
by the provider is distinct from confirmed delivery.

Connected owners, clinicians and front-desk staff can create and reply to operational
support tickets. Keep clinical records and credentials out of ticket subjects and
messages. Support availability does not grant remote access to an installation.

When SunCharts assigns a support provider, ticket lists and conversations identify
that provider. Replies retain their original provider or platform attribution when
a request is reassigned or escalated. These labels do not grant a partner clinical
API access or change the installation’s OAuth permissions.

For managed installations, an authorized service partner may launch a delegated,
read-only support session from SunCharts Connect. Connect issues a single-use code
valid for 60 seconds in the browser URL fragment; the EHR clears the fragment and
exchanges the code server-to-server over outbound HTTPS. The resulting
`partner_support` session lasts at most 15 minutes, is audience-bound to this EHR,
and is introspected with Connect on every request. Connect unavailability or
revocation fails closed. Session creation, revocation and logout are audited, all
mutations are rejected, and no EHR password or bootstrap credential is disclosed.

Support replies and reminder delivery changes update the open EHR automatically.
The outbound channel signals committed service events; the EHR resumes from its
saved cursor after a connection interruption. A bounded server-side fallback
checks for missed events. Delivery changes are shown only after the provider
receipt has been verified.

A notification bell and in-app notice announce new support replies. Read state is
saved per staff account. Opening a conversation marks only replies actually loaded
in that conversation as read. Global notices contain a generic reply alert; open
the ticket to read its contents. Initial page loads show unread counts without
repeating old pop-up notices. These notifications operate while the EHR is open.
Live updates preserve unsent support and appointment edits.

Disconnecting locally disables new service operations while retaining history.
Revoke the installation in the SunCharts console to invalidate its service token.
Clinical OAuth grant revocation and pausing managed services are separate actions.

## Other applications

Owners can register independent OAuth clients with exact redirect URIs. The engine
supports authorization code with S256 PKCE, rotating refresh tokens and revocable
per-user grants. See [API authentication](api.md#authentication). Registering a
client does not itself authorize a user or start a change feed.

Preserve the installation's encrypted credential key during recovery; see
[operations](operations.md#credentials-and-backups).

## Sun assistance

Sun prepares drafts using a practice-owned Claude or Erebine connection. Configure
the provider in **Integrations**, then select it in **Sun review**. Credentials
are encrypted in this EHR instance; SunCharts Connect is not required.

For Erebine, enter the project ID, optional workspace and endpoint, and API key.
Load the account's model catalog and choose a model. The EHR uses the pinned
P.Industries Erebine Rust SDK against `https://api.erebine.ai`. Testing the catalog
checks access and model visibility; generate a synthetic draft to verify inference.
Claude remains a separate provider with its own credential and model selection.

Each draft records its provider, model, author, status and review history. Staff
can prepare summaries, response drafts, classification and structured extraction
using the enabled capabilities. A draft does not change the patient chart, send a
message, sign a note, prescribe medication or collect payment. Approved drafts
still require the corresponding authorized clinical or administrative action.

Provider errors are reported without credentials or raw provider error bodies.
An interrupted request is not automatically resubmitted. Before retrying, review
the existing request and its outcome to avoid duplicate generation.

The movable **Sun** orb opens a floating chat over the current workspace; a full
page is also available. Patient-count and daily-workload questions use permitted
local database aggregates, with their scope and retrieval time shown. Broader text
requests use the selected practice provider after an outgoing preview; they do not
automatically read an entire chart. Navigation commands open supported workspaces and preserve
unsaved changes. Workflow Studio's Sun nodes save the provider, task and exact
source field with the workflow version. Dispatch and generated output have
separate staff review steps. Draft and workflow changes refresh open views while
preserving edits.

Enable **Workflow design proposals** on an AI connection to use **Design with Sun**
in Workflow Studio. Sun receives the current definition and supported node catalog,
without patient records or workflow runs. A server-validated proposal shows changes
to stages, nodes, forms and dependencies for review. Approval updates only the
unsaved editor draft; saving, validation and publication remain separate actions.
Editing or replacing the underlying draft invalidates an older proposal. Source
mappings cover run conditions and AI source fields, not arbitrary integration
payloads or chart-field writes. Proposed payment and communication nodes retain
their existing runtime capabilities and required reviews.

Voice is independent of the text provider. Dictation requires a browser with
verified on-device speech recognition and an installed language pack. Unsupported
browsers keep text input available rather than silently sending audio to a browser
vendor. Dictation does not submit a request automatically. Optional spoken replies
use a local device voice. Closing Sun, hiding the page or signing out stops voice
activity. This is a browser capability, not a bundled server transcription service.

## Diagnosis and procedure catalogs

Owners manage catalogs in **Practice administration → Code catalogs**. Catalogs
are stored in this EHR, scoped to the practice, and retain their source checksum,
edition and effective dates. Diagnosis and charge forms search the applicable
release for the service date. Selecting a code saves trusted source information
alongside the record; manual entry remains available without a catalog claim.
Diagnosis-to-charge links are chosen explicitly. A code match does not establish
medical necessity, payer coverage or reimbursement.

In procedure rows, type at least two characters in the code or description to
see matching CPT or HCPCS entries from the selected installed catalog. Use the
arrow keys and Enter, or select a suggestion, to fill both fields. Editing either
field manually clears its catalog provenance. The lookup reports when no applicable
catalog is installed; HCPCS Level II does not replace a licensed CPT catalog.

Prepare the official public US datasets with:

```sh
python3 scripts/prepare_terminology.py icd10cm-2027 --output /private/path/icd10cm.json
python3 scripts/prepare_terminology.py hcpcs-2026-10 --output /private/path/hcpcs.json
```

Import the resulting JSON through Code catalogs. The preparation tool checks the
official fixed-width files and retains the downloaded archive checksum. Reimporting
the same request is idempotent; editions are immutable. Add a new edition for an
update. Review future releases before importing them; imports do not run on a timer.

CPT content is not bundled. Import it only under a license permitting its use in
the practice's EHR, using the normalized catalog format and a license reference.
The catalog API also accepts ICD-10-PCS releases; the supplied download tool covers
ICD-10-CM and HCPCS Level II only. Expired licensed releases cannot be searched or
used for new selections. Previously saved clinical provenance is retained.

Appearance follows the device's light or dark setting by default. The **Color
theme** control selects System, Light or Dark; the preference is saved locally
and updates other tabs on the same browser origin.
