# Connected services

The self-hosted EHR works independently. Connecting a practice to SunCharts adds
available managed services and access from SunCharts clients.

## Connect to SunCharts

1. Configure the EHR address staff use in their browser. It can remain private. Allow the EHR server to make outbound HTTPS/WebSocket connections to `my.suncharts.app` on port 443. Use HTTPS for staff browser access outside localhost; it does not need to be publicly reachable.
2. Open **Connected apps → Connect to SunCharts**.
3. Sign in at `my.suncharts.app`, choose the owning practice and approve the connection.
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
