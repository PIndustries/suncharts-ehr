# Provider adapters and automated retrieval

Development milestone: October 24, 2026. This extends the generic gateway and
[277CA review](automated-delivery-277ca.md). The implementation speaks actual
provider protocols; local protocol tests are not live enrollment, payer acceptance,
certification, or complete native workflow support.

| Adapter | Delivery | Retrieval | Local verification |
| --- | --- | --- | --- |
| `stedi` | Documented raw 837P JSON endpoint, raw Authorization key, stable Idempotency-Key | Poll Transactions with opaque page token; bounded transaction input download | Actual loopback HTTP, including signed-download authorization separation |
| `claim_md` | Multipart AccountKey/File upload | Form POST ResponseID feed; canonical per-message JSON evidence | Actual loopback HTTP, multipart fields and durable numeric cursor |
| `office_ally_sftp` | Enrolled SFTP mailbox; `837P_<submission UUID>.x12` | Read-only mailbox discovery/download of 999, 277CA, TA1, 835 and other files held for review | Actual OpenSSH upload/download plus wrong-host-key refusal |
| `availity_sftp` | Enrolled SFTP batch mailbox | Same protected mailbox retrieval with independent account binding | Actual OpenSSH upload/download plus shared host-key refusal check |
| `gateway` | Existing SunCharts HTTPS gateway contract | Provider retrieval is not enabled for generic gateway routes | Existing receipt/retry tests retained |

No Office Ally or Availity REST endpoint is invented or used. Their adapters use
SFTP batch transport. Provider-specific mailbox paths, authentication and naming
acceptance must be confirmed during enrollment. This preview supports Unix OpenSSH
public-key authentication; password-only mailboxes require further integration.

## Operator configuration

The existing `ENGINE_CLEARINGHOUSE_CONFIG` points to a private server JSON file.
The web UI displays safe route/connection metadata, credential readiness, pause,
resume, poll requests, durable retrieval state and evidence history. Account setup
and secrets remain server operations. No API accepts browser-provided transport
URLs, SSH key contents, passwords or signed document URLs.

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

## Durable worker behavior

The worker polls every configured interval (30 seconds minimum). For Stedi it
retains the opaque token returned even on an empty page. For Claim.MD it retains
the numeric last response ID, refusing regression. SFTP listings are rescanned and
deduplicated rather than advancing a fragile filename cursor. Discovery commits
all observations and audit events in the same transaction as the next position.
If that fails, the existing cursor remains and an expired read lease can safely
replay discovery. Unique account/report identities prevent duplicate processing.
Changed evidence under the same identity is held rather than silently overwritten.

Downloads have a separate durable lease and up to three read-only attempts. Failed
or unsupported documents remain in the inbox; staff may explicitly retry a failed
download that has no original text. Original content, hashes, source identities and
native links cannot be rewritten. Binary and oversized documents are held without
claiming a supported text import; retain the provider originals. Report and connection events are append-only.
A paused, removed or changed account binding cannot block another configured
account's queue or cross its tenant boundary.

Changing account, partner, usage, destination, credential reference or SFTP mailbox
requires a new route key. Poll interval and approved download-host changes retain
existing cursors. Editing a seed position does not rewind an existing connection;
create a new reviewed route key for an intentional rescan. Re-enrollment, endpoint
provisioning and external companion-guide acceptance are not inferred from history.
Pausing affects future work; already leased network operations may finish and
retain their evidence.

## Web workflow and native reconciliation

In **Clearinghouse → Clearinghouse connections**, inspect the four provider cards,
connection state, successful polls, pages committed and saved-cursor indicator.
Owners can pause/resume or request a poll with an attributed reason and current
version. **Retrieved acknowledgment & status inbox** shows mode-filtered discovery,
attempts, raw-file/hash provenance, parsed issues, native links and review history.
Explicit refresh controls show worker results without background audit polling.

- 277CA: choose verified clearinghouse/payer origin, stage exact original text, then
  use existing per-claim/service identity and version review. A Stedi submission's
  initial response is permanently clearinghouse-origin evidence. The parser also
  recognizes information-source NM1 AY/46 used by Stedi; identity still must match
  the independently reviewed frozen partner/payer. Retrieved documents cannot be
  applied through a different trading partner's native submission.
- 999/TA1: inspect an exact delivered native submission, load the retrieved original,
  then review its interchange/group/transaction controls. The existing technical
  acknowledgment transaction retains the inbox link atomically. Unsupported formats
  or an already linked report cannot overwrite a different decision.
- 835: select the native payer and stage the exact retrieved file in the existing
  ERA review workflow. Matching and posting remain separate balanced, versioned
  operations. Retrieval never posts a payment.
- Claim.MD structured status: inspect the delivered submission and current versions,
  then explicitly link exact control, NPI, tax ID, member, payer, charge and service
  date evidence. The link does not change claim status or balances. Payer outcome
  and ERA posting still require their existing independent reviews. Broader native
  interpretation of Claim.MD status/message codes remains future work.

## Legacy migration mappings

The nonsecret exporter now accepts optional `provider` (`stedi`, `claim_md`,
`office_ally_sftp`, `availity_sftp`) and `provider_report_id` in the acknowledgment
manifest. `claimmd_status` requires a single claim JSON object with a patient control
number and no credentials. Source text (ASCII X12 or UTF-8 Claim.MD JSON), partner/claim relationships and declared
origin remain historical. Whole response feeds must be split into per-claim records
for explicit review; the exporter does not guess claim relationships.

| source system/provider evidence | Preserved | Native mapping |
| --- | --- | --- |
| x12_partners and source claim x12_partner_id | Existing allowlisted IDs and relationships | Owner reviews a native partner; no credentials or enrollment activated |
| Provider name and remote report/response ID | Explicit source metadata | Owner chooses reviewed native partner and stages a historical inbox record |
| Original 999/TA1/277CA | Exact bounded ASCII text and source links | Existing native control/issuer review, with immutable source provenance |
| Claim.MD structured status JSON | Exact source JSON text; account keys rejected | Historical inbox review; explicit identity-only evidence link |
| Source production flags and delivery/status history | Read-only source evidence | Cannot send, accept claims, activate polling, or post payments |
| AccountKey, API keys, SSH login/key material, endpoints and live cursors | Excluded | Independently provision credentials and a new account-bound route |

`POST /api/v1/billing/retrieved-reports/from-source` is owner-only and idempotent.
It creates an inactive `historical_import` connection, original inbox evidence and
an immutable source link atomically. That connection cannot be resumed or used
for transport. It creates no native claims or delivery jobs. This supports reviewing
legacy Claim.MD/other provider history before switching the active account.

API 0.8.0 documents connections, connection actions/history, retrieved report
list/detail/retry/status link, historical mapping and optional `remote_report_id`
on 277CA, technical acknowledgment and ERA imports. All routes use existing billing
OAuth scopes and role boundaries. Migrations 0012 and 0013 add durable retrieval,
immutable evidence guards and source links. No proprietary SunCharts connector
implementation is changed.

## Verification and release boundary

Automated HTTP tests exercise actual provider request shapes, stable idempotency,
receipt identity, signed-download key separation, mode/direction filtering, durable
cursor replay after injected audit failure, original-evidence protection, source
mapping rollback, tenant/role/version controls, failed-download holds and native
review without premature payer acceptance. Separate tests execute both SFTP flavors
against real loopback OpenSSH and reject a mismatched host key. Reproduce those
three explicit tests with `TEST_DATABASE_URL=<disposable database> python3 scripts/verify_provider_sftp.py --toolchain 1.99.1`. These tests use
synthetic claims and local servers, not provider-owned test accounts.

The GUI assets are syntax-checked and served by the local engine. Interactive
browser verification remains unavailable after the browser tool's local URL policy
rejection; no new visual walkthrough or screenshots are claimed. Live provider
credentials/enrollment, password-only SFTP, account-specific naming/companion guides,
external response fixtures, large batch profiles, webhooks, broader claim/ERA
profiles and complete standards and clinical acceptance remain separate release work.

Provider references checked October 24, 2026:
[Stedi raw claims](https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-claims-raw-x12),
[Stedi transaction polling](https://www.stedi.com/docs/healthcare/api-reference/get-poll-transactions),
[Stedi input retrieval](https://www.stedi.com/docs/healthcare/api-reference/get-transactions-input),
[Claim.MD API](https://api.claim.md/),
[Office Ally SFTP configuration](https://support.officeally.com/technical-issues/configuring-your-sftp-connection),
[Availity batch EDI](https://www.availity.com/wp-content/uploads/2024/06/CHC-Essentials-Msg-3.pdf),
[Availity response files](https://essentials.availity.com/availity/help-open/oxy_ex-1/onb-essentials-provider-help/EDI/response_files/_topics/c_edi_response_files.html).

## Claim.MD ERA retrieval and staging (API 0.9.0)

`/services/eralist/` uses its own durable ERAID/Page state, independent of ResponseID.
Requests explicitly use `NewOnly=0`; a provider download marker cannot hide a report
after a crash. Full pages retain a fixed ERAID and increment Page; the high water
advances only after the final page is persisted. The account-wide last_eraid never
skips unpersisted rows. Discovery and cursor updates share one audited transaction.
Each read has an expiring lease; failed results retain the previous cursor.

`/services/era835/` uses the discovered eraid and server credential. It requires a
matching returned ID and one ASCII original, at most 48 KB. Provider JSON/account
errors, mismatched IDs and failed reads retry through the existing bounded inbox;
three failures quarantine the report. The exact extracted X12 string and SHA-256
are retained, with only allowlisted stable list metadata. Provider download URLs,
credentials and mutable download timestamps are not retained. Full ISA mode must
match the dedicated T/P route; ST-only files depend on that enrolled account.

The Claims & remittances and Clearinghouse workspaces show ERA feed state,
last success, pages, attributed owner controls, staging results, holds, originals,
and workflow history. `GET /api/v1/billing/era-automation` returns recent 100 items
per category. Owner actions at `/era-automation/{key}/actions` require If-Match,
a reason, and enable/disable staging or request a poll. Existing connection pause
stops new discovery, downloads and staging; an in-flight read may finish.

Automatic staging defaults off. When enabled, a worker checks original payer,
trace, date and exact cents against discovery metadata, requires a unique native
payer code, and suggests only unique exact patient-control/previously reviewed
alias matches with provider NPI and tax ID. It snapshots claim/account versions,
uses existing reconciliation checks, and never selects a CO credit. The packet
remains staged even when balanced. Staff review current matches and balances,
choose contractual credits, reconcile, and explicitly post through the existing
atomic ledger workflow. PR stays responsibility evidence. Reversal appends offsets.

Malformed/unknown/ambiguous payer identities and duplicate payer/trace documents
produce immutable held outcomes without native/ledger mutations. Staged packets
may carry unresolved row findings; staff reconcile those in the native review UI.
Held originals can be manually imported after independent reconciliation. Outcomes
are historical findings, with current native remittance status shown separately.
A nested transaction protects staging from partial changes; audit failure rolls
back the packet, suggestions, source link and outcome together. Replaying a report
or running concurrent workers cannot create a second packet or payment.

The source system ERA manifest optionally accepts `provider: "claim_md"` and a numeric
`provider_report_id` (ERAID). These remain historical metadata, alongside original
835 bytes and the source payer reference. Import does not seed a live ERA cursor,
enable staging, infer migrated balances, or bypass native review. See
[claims/remittance mappings](claims-remittances.md).

Verified against the [published Claim.MD API](https://api.claim.md/) on October 24,
2026, using synthetic loopback contract fixtures. Provider-owned account acceptance,
large/multiple-transaction 835s, broader recovery chains, unattended ledger posting and full
native workflow support remain outside this implemented profile.

API 0.10.0 expands native ERA handling with signed PLB settlement review and
exact-original CLP22 recovery. Retrieved 835s now use native parsing to classify
originals, including ISA-defined delimiters; malformed originals stay quarantined.
Automatic staging never supplies a PLB review or original-recovery match, and
never posts either ledger. See [provider settlements](claims-remittances.md#provider-settlements-and-claim-recovery-api-0100)
for supported cases and explicit remaining 835 boundaries.

API 0.11.0 now supports [multi-transaction files and ordered correction chains](era-files-corrections.md), including repeated correction cycles and atomic reverse-order file undo. The earlier single-transaction/repeated-chain exclusions describe the 0.10.0 profile. Broader payer-specific/TR3 conformance remains pending.
