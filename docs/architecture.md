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
