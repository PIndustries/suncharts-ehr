# Architecture

SunCharts Engine is a Rust HTTP service with PostgreSQL persistence and a web
interface served by the same binary. It is the backend for SunCharts EHR. Separate
clients use HTTP contracts and do not link the AGPL crate.

## Layout

| Path | Purpose |
|---|---|
| `src/` | Authentication, clinical workflows, billing, integrations and HTTP handlers |
| `web/` | Browser workspace and styles; no separate frontend build step |
| `migrations/` | Sequential PostgreSQL schema migrations |
| `api/openapi.json` | Published API contract |
| `tests/` | Database-backed and HTTP integration tests |
| `scripts/` | Import tools, frontend fixtures and transport verification |

`src/lib.rs` assembles routes. `src/main.rs` applies migrations and starts the
server and background workers. `ClinicalBackend` defines the core visit interface;
`PostgresBackend` implements it. Other workflow modules use the authenticated
installation database directly.

## Identity and transactions

The standalone EHR has its own staff accounts and sessions. Tenant identity comes
from authentication, never a request body. OAuth grants bind an application,
tenant and user; local role permissions still apply. Patient portal accounts use
a separate cookie, account-bound requests and explicit publication of immutable
visit-summary versions; a staff session does not grant patient portal access.

State mutations and their audit events share a database transaction. Versioned
writes use quoted `If-Match` headers. Clinical signatures, amendments, revisions,
source imports and ledger entries preserve history rather than overwrite it.

An appointment moves from booking through arrival to an encounter. Enabled rooming
staff may start a checked-in visit and record intake/vitals while retaining its
assigned clinician. That clinician owns SOAP, signing and amendments. Checkout,
results, follow-up tasks and billing have separate state transitions. Prescription
orders also retain their own versioned lifecycle and reviewed authorization
snapshots, distinct from reported medication use and external pharmacy delivery.

Background delivery and retrieval use durable jobs, leases and provider evidence.
Ambiguous external outcomes require reconciliation rather than an unqualified
retry. See [clearinghouses](clearinghouses.md) and [scheduling](scheduling.md).

## Workspace configuration and access

Workflow Studio maps each supported navigation module to its native workspace,
chart areas and actions. Practice owners can save display names, grouping,
ordering, visibility and enabled chart areas as versioned workspace settings.
Restoring defaults prepares a draft; saving requires a reason and preserves the
previous revision. Hiding a module changes presentation, not authorization.

Named access policies restrict existing staff roles by resource and action
(view, create, edit and delete). Assignment requires a matching native role;
owner access remains available for recovery. Policy and assignment changes are
audited and revoke affected browser, Connect identity and OAuth sessions.
Protected requests pass both the policy middleware and existing native checks.
Unmapped routes fail closed for assigned users. Generic action commands require
both edit and delete permission; a delete flag never permits deleting immutable
clinical history. Background jobs retain their separate review requirements.

The map exposes supported native bindings. It does not execute arbitrary code,
create new clinical record types, or replace signature, tenant or payment rules.
Workflow definitions and workspace settings have separate save/version lifecycles.

## Workflow execution

Saving a definition creates a draft. Published definitions can start runs from
supported native appointment, signed-visit, referral and eligibility events, and
from inbound email, call, SMS or fax records after staff links them to a patient.
The durable event queue records the published definition version. A changed or
unpublished definition supersedes its queued start; existing runs keep their
immutable definition revision. Editing or arranging the Studio canvas does not
change an existing run.

Dependencies and supported conditions determine which steps are ready. Native
bindings require evidence from the run's tenant, patient and linked encounter.
The readiness API reports missing, pending or ambiguous evidence; completion and
approval recheck it against current native records. Signing an encounter, reviewing
an intake packet, accepting a claim and confirming a payment each retain their
own native requirements. Opening checkout does not establish payment, and an
eligibility response still requires benefits review. Reviewed dispatches also
recheck the active run, exact step, native permissions and downstream OAuth scopes.

A Studio patient form issues a packet with immutable fields and mappings from the
run's definition version, linked to its step, patient and appointment. The secure
link is shown once. Submission preserves the patient's answers; staff review
records evidence without completing the workflow or changing chart fields.
Staff can then explicitly select mapped answers for `preferred_name`, `pronouns`,
`language`, `administrative_gender`, `phone` or `email` in native demographics.
This handoff validates the stored answers, checks the current chart version, and
records the change and packet provenance atomically. Other answers remain review
evidence; signed notes and clinical orders keep their existing authoring paths.

Native bindings and actions are bounded by the supported catalog. Clinical rules,
signatures, financial safeguards and tenant access remain authoritative. Provider
credentials, payer configuration, communication approval and payment setup remain
required; a workflow definition does not supply them. Current hosted payment
execution remains in test mode.

## Connections and imports

Optional SunCharts services connect through OAuth and server-to-server APIs.
New installations initiate an authenticated outbound TLS WebSocket to SunCharts;
no public EHR URL or inbound firewall port is required. The installation channel
transports bounded requests but grants no clinical authority. Requests retain
user OAuth credentials and pass the ordinary local router authorization.
Enrollment uses session-bound owner approval and PKCE, then rotates to the
installation credential. Heartbeats and reconnects update local connection health.
A connection neither migrates records nor proves every workflow is synchronized.
Change notices identify changed records without embedding chart contents or secrets.

Migration preserves source records separately from native clinical state. Staff
must review supported mappings explicitly. An imported note never becomes a newly
signed native encounter. See [migration](migration.md).
