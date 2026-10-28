# Clearinghouse connections

The engine supports Claim.MD and Stedi HTTP adapters, Office Ally/Availity SFTP
mailboxes and an operator-configured HTTPS gateway. Provider enrollment, account
mode, mailbox conventions and payer acceptance must be established separately.

## Claim.MD in the web application

Open **Clearinghouse → Clearinghouse API settings → Claim.MD connection**. Create
or choose the enrolled trading partner, then save its label, usage mode, AccountKey,
discovery start, initial ResponseID and polling interval.

Saved keys are encrypted and never returned or prefilled. The connection starts
disabled. Test the saved key against the fixed Claim.MD payer-directory service,
then explicitly enable delivery/retrieval. The authentication test sends no claim
or patient data; it does not prove enrollment, account mode or payer acceptance.

Editing settings pauses automation. Credential/cursor changes create a new route
revision; original reports and delivery history retain their earlier identities.
Keys are not shared across saved connections. Back up the credential master key
as described in [operations](operations.md#credentials-and-backups).

## Server-configured routes

Set `ENGINE_CLEARINGHOUSE_CONFIG` to a private JSON file for other adapters or
legacy environment-managed routes. Never put keys in that file: route entries
reference environment-variable names. The web workspace shows safe route metadata,
pause/resume, polling and retrieved evidence.

A file has `{"routes": [...]}` with at most 50 entries. Keys are unique per tenant.
Bind each actual provider account/mailbox to one route and tenant. API credentials
cannot be shared across configured routes; SFTP host/port/user combinations are
also unique. Different tenants must use separately authorized provider accounts.
Credential rotation must retain the same account; use a new route key when changing
accounts. Credentials and file paths are never included in browser responses.

Example Stedi route:

```json
{
  "key": "stedi-enrolled-test",
  "adapter": "stedi",
  "tenant_id": "00000000-0000-4000-8000-000000000001",
  "partner_id": "00000000-0000-4000-8000-000000000003",
  "usage": "T",
  "endpoint": "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/raw-x12-submission",
  "credential_env": "ENGINE_CLEARINGHOUSE_TOKEN_STEDI",
  "retrieval": {
    "start_at": "2026-10-01T00:00:00Z",
    "core_base": "https://core.us.stedi.com/2023-08-01",
    "interval_seconds": 60,
    "download_hosts": ["stedi-default-core-artifacts.s3.us-east-1.amazonaws.com"]
  }
}
```

API hosts and submit paths are pinned to published endpoints. Only explicit numeric
loopback HTTP test routes may override them. Stedi input retrieval permits a single
signed download hop to an explicitly listed AWS artifact hostname, over HTTPS.
It never forwards the API key on that hop, follows another redirect, persists the
signed URL, or follows arbitrary artifact URLs from discovery metadata. Provision
additional exact artifact hostnames only after validating them with the provider.

Example Claim.MD route (same common tenant/partner/usage fields as above):

```json
{
  "key": "claimmd-enrolled-test",
  "adapter": "claim_md",
  "tenant_id": "00000000-0000-4000-8000-000000000001",
  "partner_id": "00000000-0000-4000-8000-000000000004",
  "usage": "T",
  "endpoint": "https://svc.claim.md/services/upload/",
  "credential_env": "ENGINE_CLEARINGHOUSE_TOKEN_CLAIMMD",
  "retrieval": {
    "start_at": "2026-10-01T00:00:00Z",
    "claimmd_response_id": "0",
    "interval_seconds": 60
  }
}
```

Claim.MD uses its ResponseID position rather than start_at for discovery. The
initial response ID defaults to zero; subsequent positions come only from committed
provider responses. `start_at` remains recorded as an operator review boundary.
Claim.MD's `status: A` does not automatically mean payer acceptance. Known response
fields and each message are retained as canonical JSON, not converted to X12 or
claimed to be a byte-for-byte copy of the complete provider page. Unknown fields
are excluded. This adapter does not synthesize 277CAs or ERA payments from messages.

Example SFTP route; use `office_ally_sftp` or `availity_sftp` as appropriate:

```json
{
  "key": "officeally-enrolled-test",
  "adapter": "office_ally_sftp",
  "tenant_id": "00000000-0000-4000-8000-000000000001",
  "partner_id": "00000000-0000-4000-8000-000000000005",
  "usage": "T",
  "endpoint": "sftp://your-enrolled-host.example:22/provider-confirmed-upload-directory",
  "sftp": {
    "username_env": "ENGINE_CLEARINGHOUSE_SFTP_OFFICEALLY_USER",
    "private_key_env": "ENGINE_CLEARINGHOUSE_SFTP_OFFICEALLY_KEY_FILE",
    "known_hosts_env": "ENGINE_CLEARINGHOUSE_SFTP_OFFICEALLY_KNOWN_HOSTS_FILE",
    "inbox_dir": "/provider-confirmed-response-directory"
  },
  "retrieval": {"start_at":"2026-10-01T00:00:00Z","interval_seconds":60}
}
```

The *_KEY_FILE and *_KNOWN_HOSTS_FILE environment values are absolute paths to
regular files. Private keys must have private permissions. Pin the enrolled server's
SSH host key through an independently verified known_hosts file. The implementation
requires strict checking, disables password/interactive auth, ignores ambient SSH
configuration and agents, and uses a private temporary workspace. It uploads under
a temporary name and renames to the immutable submission filename after the write.
A successful transfer/rename proves mailbox delivery only. It does not prove file
processing, payer routing or claim acceptance. Ambiguous failures become `unknown`
and never automatically resend. Confirm that the enrolled mailbox accepts this
atomic rename workflow and the 837P filename before enabling it.

Discovery lists up to 1,000 safe filenames per mailbox and deduplicates immutable
names. Provider files must not be overwritten or reused under the same name.
The engine never deletes remote responses. Retention and archival with the provider
remain operator responsibilities. Response files are limited to 48 KB; large or
unsupported reports are held for review. Paths and filenames reject batch-command
metacharacters. Test/production isolation must use the correct enrolled mailbox;
full X12 envelopes are additionally checked against the route's usage indicator.
ST-only downloads rely on account/mailbox isolation and explicit native review.


## Delivery, acknowledgments and ERA retrieval

Release and queue each submission explicitly. Worker receipts are distinct from
technical acknowledgments and payer outcomes. SFTP transfer/rename proves mailbox
delivery only. Review retrieved 999/TA1/277CA evidence against its native submission;
unknown or unsupported reports remain held for review.

Durable cursors advance only after evidence is saved. Discovery and original-file
retrieval have separate state. Download failures retain a retry path. Pausing new
work does not recall an operation already leased to a worker.

Claim.MD response messages are canonical structured evidence, not synthesized X12
or automatically posted payments. Its ERA discovery/download path stages originals;
automatic remittance staging is a separate opt-in. Accounting still requires the
review and posting steps in [billing](billing.md#era-posting).

Ambiguous delivery cannot be blindly resent. Reconcile the original provider
receipt first. Credentials are pinned per attempt; changing a route cannot redirect
an uncertain request to a different account. Response files are limited to 48 KB;
large/unsupported reports require review. The engine does not delete remote files.

SFTP requires separately provisioned Unix OpenSSH public-key authentication and
strict host-key checking. Password-only mailboxes and unconfirmed provider-specific
REST APIs are not supported. See [contributor checks](../CONTRIBUTING.md#checks)
for the optional SSH fixture.
