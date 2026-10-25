# Bootstrap verification — October 23, 2026

Local checks used synthetic records and isolated PostgreSQL 16.15. Nothing was
deployed, published, migrated from a real source system installation or submitted for certification.

## Native engine

Rust 1.99.1 formatting, all-target Clippy with warnings denied, and the
PostgreSQL-backed suite pass. The initial engine also compiled with Rust 1.89.0
and locked dependencies. Six broad integration/contract tests now cover the visit, OAuth, migration and
initial FHIR boundary. The original workflow checks cover:

- Complete patient → booking → check-in → visit → vitals/SOAP → signing →
  amendment → signed patient record workflow.
- Expired/wrong-audience assertions, cross-tenant reads, wrong patient,
  read-only/front-desk writes, another clinician's documentation, incomplete note,
  missing/stale versions and invalid vitals.
- Concurrent edits: one succeeds, one conflicts. Injected audit failure during
  signing rolls back both visit state and appointment completion.
- Signed content protection through both API and ordinary SQL, plus amendment
  and audit history mutation guards.
- Browser login, cookie flags, exact Origin checking, directory/workspace reads
  and logout revocation through the HTTP router.

## Standalone GUI

Browser-driven validation against the local binary completed the full clinician
journey for `Avery Synthetic`, MRN `SIM-WEB-001`. Signed SOAP and vitals became
read-only. An amendment changed the follow-up interval while preserving the
original note. Reload retained the session, patient, signed visit and correction.
Historical local visual evidence is not included in the public source tree.

The initial desktop journey is verified. Responsive CSS is present; a mobile
browser walkthrough, accessibility audit and complete multi-role GUI testing are
pending. Existing native SunCharts apps were not rebuilt or switched.

## Existing SunCharts repository

The companion branch passes all-target Clippy, 150 library tests, the existing
full source system API flow, Today/Inbox/chart smoke test and three API contract checks.
These use local mock source system, not deployed production. The new gateway integration
test verifies source system default selection, native opt-in, delegated identity,
ignored tenant-spoofing headers, If-Match/ETag forwarding, display-session denial
and independent gateway audit.

No source system connector implementation files were modified. The native namespace is
additive; a normalized source system implementation of the same contract is future work.

## Remaining release boundaries

Full FHIR/SMART/US Core/Bulk Data, ONC criterion conformance, production identity
and consent, clinical review, external interfaces, complete migration/cutover, load testing,
backup/restore validation and public-source/dependency review remain pending.
The capability roadmap records implementation gaps, not release acceptance.

## Independent connection and migration milestone

All-target Clippy with warnings denied and all PostgreSQL-backed Rust tests pass
in both repositories on Rust 1.99.1. The SunCharts suite includes 150 library tests
and all existing integration/contract binaries, including the source system full flow,
FHIR/REST consoles and clinical workspace tests. The separately invoked, normally
ignored two-service test also passes against a real local engine process.

New engine integration checks cover PKCE/callback validation, consent single-use,
scopes, refresh rotation/replay revocation, live-stream revocation, token hashing,
migration count/reference reconciliation, exact retries and import idempotency,
source history immutability, tenant/owner restrictions and audit-failure rollback.
FHIR tests verify Patient read/search/pagination, media type, denied unsupported
searches, OperationOutcome errors and tenant isolation. Search reads do not emit
mutation notices. Two Python exporter tests verify source-field preservation,
private output permissions, overwrite refusal and failure on missing identity.

The real cloud/engine test covers discovery, explicit consent, callback and callback
replay, pinned user/clinic identity, per-user access denial, activation, patient
write, notice polling, token refresh/rotation, encryption/key rewrap and disconnect.
This is local synthetic evidence; the production my.suncharts.app callback has not
been deployed or exercised.

Browser verification covered Connected apps/grant status, package upload and
reconciliation, explicit import, refreshed directory and imported source-note
history. A synthetic snapshot was first staged by API and imported through the GUI;
the same package was then uploaded and reconciled through the GUI. The imported
Morgan Synthetic chart displayed the original source ID and read-only history,
with no fabricated native signed visit. Existing signed visits survived restart.
Historical local visual evidence is not included in the public source tree.

No live source system export was run. Export field/endpoint variability needs validation
against each supported source version before real migration. Mobile browser,
accessibility and multi-role GUI coverage remain pending. OAuth authorization
request rate controls, expired-record cleanup and complete operational hardening
also remain release work. Native Apple clients have not been switched or rebuilt.

## Native clinical list milestone

Eight engine integration/contract tests and two Python exporter tests pass on
Rust 1.99.1 with PostgreSQL 16.15; formatting and all-target Clippy deny warnings.
New tests cover all three list kinds, clinical validation, concurrent version
conflicts, role/tenant boundaries, immutable revisions/reviews, no-known conflicts,
stale review prevention and injected audit-failure rollback. A synthetic migration
imports all three kinds, checks mapping suggestions and original fields, requires
explicit native creation, prevents duplicate source promotion, and blocks reviewed
until source reconciliation. New source arrivals invalidate an earlier review.

The two-process SunCharts OAuth test now creates, reads and reviews a native problem
through the actual authenticated gateway. The existing gateway integration test
also passes. Existing source system routing was not changed.

Browser verification created native problem/allergy/medication entries, changed a
problem to resolved, viewed both revisions, recorded the problem-list review and
verified persistence after restart. A separate synthetic imported allergy was
previewed with source details and reconciled into a linked native allergy using
the clinician acknowledgement and reason fields. Automated migration tests cover
problem and medication source mappings as well. Evidence:

This is not complete native workflow support yet. Exact compatibility endpoint contracts,
source-version fixtures, lookup translations, additional structured allergy and
medication fields, terminology, prescribing/eRx and three-domain FHIR conformance
remain pending; see [clinical-lists.md](clinical-lists.md). No production data,
deployment or native-app rebuild was involved.

## Native orders, labs and results milestone

Eleven PostgreSQL-backed engine tests and four Python exporter tests pass on Rust
1.99.1. All-target Clippy denies warnings, formatting passes and both web scripts
pass syntax checks. New tests exercise draft editing/placement, safe create retries,
role/tenant boundaries, specimen timing and linkage, numeric/text/coded/absent
results, partial panel coverage, concurrent finalization, immutable snapshots,
version-specific review and correction after completion. Injected audit failure
rolls back result revision and order-state changes. Changed acknowledgment retries
cannot overwrite an original note. Preliminary acknowledgments also expire on a
new final revision. Source import tests retain order/report relationships, offsets,
values, original authors and external-unverified provenance without inventing a
native specimen. CSV conversion tests reject broken relationships.

The SunCharts companion passes Clippy, 150 library tests, its legacy integration
full-flow test and the native gateway boundary test. Its real two-server OAuth
test now also creates/places a laboratory order, records specimen intake and a
final panel, opens the inbox, acknowledges and completes it through the gateway.
source system connector code was not changed.

Browser verification created a native order, placed it locally, recorded serum
receipt, entered a preliminary critical-flagged panel, finalized it, opened it from
the result inbox, acknowledged it and completed the order. A correction reopened
the order, preserved all three report revisions and required a fresh acknowledgment.
A separate synthetic source system order and report were reconciled through the web UI;
values/units/ranges/time and unverified source provenance remained visible, with an
explicit missing-native-specimen exception. Evidence:
.

No live laboratory, real source system export, patient data or external delivery was used.
Live HL7/vendor interfaces, complete specimen corrections, source vocabulary
translation, binary/document migrations, regulatory conformance, mobile/accessibility
validation and one-to-one legacy contracts remain pending. See
[orders-labs-results.md](orders-labs-results.md) for explicit scope boundaries.

## Workspace sidebar correction

Replaced the flat button stack with patient-care and workspace groups, consistent
SVG icons, an explicit current-page indicator, a signed-in role area and a compact
source/sign-out footer. The width stays consistent on desktop; narrow screens use
an expandable menu with Escape handling and focus restoration. Switching sections
resets page scroll and updates the active item after a successful load.

Browser checks visited all four destinations and confirmed exactly one aria-current
item per page. The desktop layout was visually checked; a narrow-viewport walkthrough
is still pending. JavaScript syntax, formatting, all-target Clippy and all 11 existing
engine integration tests pass. Historical local visual evidence is not included in the public source tree.

## Native scheduling and appointments

Synthetic PostgreSQL integration tests cover practice/role isolation, provider,
patient, named-room and availability-block conflicts, two concurrent bookings,
allowed state transitions, stale/missing versions, exact booking/block retries,
block cancellation, no-show/cancellation capacity release, source-history mapping
and duplicate prevention, and audit-failure rollback. Check-in → encounter start →
SOAP save → signed completion produces five attributed appointment versions.
Source import creates no active appointments automatically. The Python proposal
mapper is tested for explicit timezone conversion, second-based duration, custom
status rejection, recurring/all-day rejection and both DST ambiguity/gap cases.

The running standalone preview was walked through in the browser: new booking,
rescheduling, check-in and three history versions; provider block; seven-day view;
raw source system appointment review with blank naive dates and verified patient/provider,
manual time and facility/room selection; then successful native booking showing
its preserved source linkage. Screenshot: historical local screenshot. Browser
walkthrough used the desktop-width preview; a narrow-device walkthrough remains
pending. Automated tests exercise cancellations/no-shows and audit rollback.
No production deployment, live source system migration, FHIR scheduling conformance or
complete native workflow support is claimed. See `scheduling.md` for remaining gaps.

Final local checks: Rust formatting, Clippy with warnings denied, all 13 PostgreSQL
integration tests, JavaScript syntax checks and all 7 Python exporter/mapping tests
pass. Existing source system connector files were not changed.

## Clinical workspace UI revision

The desktop UI now uses a compact application header, restrained navigation,
consistent smaller controls and a semantic scheduling table with aligned time,
patient/appointment, provider, location and status columns. Appointment details,
booking/editing, and provider blocks open in a contextual side panel with an
explicit close control and Escape dismissal. The initial agenda no longer spends
space on oversized metric cards or an empty details panel.

Patient charts have a persistent identity/allergy context and explicit Overview,
Clinical lists, Orders & results, Visits and Source history navigation. Overview
shows native active problems/medications, recent visits and outstanding results;
refuted/error entries are excluded from active summaries, and critical reports
sort first and retain a visible critical label. Missing allergy review is shown
as unconfirmed, never inferred as no known allergies. The directory can be hidden
for a wider chart. Switching chart sections hides existing forms without rebuilding
them; this preserves in-progress inputs within the same loaded patient chart.
Reloading or leaving that chart is not a draft-persistence feature.

Browser verification on the running desktop preview covered chart section
selection, signed-record access, input preservation across section switches,
directory collapse/reopen, source history, results-inbox → Orders & results,
appointment details/edit/new-booking forms, panel close/Escape, and seven-day
schedule navigation. Existing server integration tests (13), Rust formatting and
Clippy, and all four JavaScript syntax checks pass. No backend/schema changes in
this UI revision. Narrow-device walkthrough and formal accessibility audit remain
pending; responsive rules and semantic controls are implemented.


## Native insurance and local billing

The financial milestone adds native payers, dated primary/secondary/tertiary
coverage, draft encounter charges, local posting with frozen payer/policy versions,
recorded payments/credit/debit adjustments, append-only reversals and an account
worklist. Native financial endpoints have explicit `billing.read` / `billing.write`
OAuth consent and role checks. No payment rail, claim submission or eligibility
network is connected. The existing general staff source-history access policy is
unchanged; imported financial originals remain governed by that policy.

Three new PostgreSQL integration tests exercise coverage priority/date conflicts,
exact integer-cent accounting without multiplying line totals by units, creation
retries, missing/stale versions, unsigned-visit posting rejection, posted charge
immutability, frozen coverage after policy edits, overpayment rejection, reversal
uniqueness, patient/tenant permissions, concurrent payments, database triggers and
audit-failure rollback of entry/account/version/history. A full synthetic migration
imports payer, policy, charges and AR evidence without activating accounts; explicit
native reconciliation retains source IDs and originals. Real OAuth code/PKCE
exchanges verify clinical-only denial and independent billing read/write scopes.
The financial EHI exporter has three tests covering relationship preservation,
source decimal strings/signs, duplicate package rejection, mismatched patients and
fractional/nonfinite money rejection.

Running-browser verification covered payer creation, patient coverage creation,
charge capture from a signed visit, posting, manually recorded payment, reversal,
account history, worklist filtering and chart handoff. A second synthetic EHI
package was generated with the exporter, staged/reconciled/imported locally, and
its payer/coverage/charges reconciled through the web UI. Source fee/date fields
needed explicit review; the source charge account remained a draft and original
AR evidence produced no automatic payment. Source-backed draft editing did not
require a fabricated native visit.


Final checks: all 16 PostgreSQL integration tests, 10 Python exporter/mapping tests,
Rust formatting, Clippy with warnings denied, and JavaScript syntax checks pass.
Patient chart loading stages all sections before publishing a complete patient
workspace, so a failed section read does not replace the current chart with partial
state. Financial source rows remain subject to explicit field review.

## Claims and ERA remittances — 2026-10-23

All 19 PostgreSQL integration tests, 3 bounded-835 parser unit tests, and 13 Python
exporter/mapping tests pass. Formatting, Clippy with warnings denied, JavaScript
syntax and contract-reference checks pass. New coverage verifies:

- Claim packet preflight, release immutability, export without state mutation,
  attributed external lifecycle evidence, and corrected original resubmission
  after rejection without fabricating a payer control number.
- Exact payment/selected CO posting with PR retained; duplicate trace/request
  handling; wrong identity, unbalanced data and stale account reviews blocked.
- Audit failure rolls back ERA, claim and ledger changes together; concurrent
  posting succeeds once; manual reversal of ERA entries is blocked; dedicated
  reversal restores balances and claim state while retaining original evidence.
- Downstream replacement drafts block ERA reversal until independently resolved;
  immutable posting/document guards reject history mutation.
- source system claim/global ERA history imports without native activation, maps to
  independently reviewed drafts/staged documents, and retains original fields.
  Clinical-only OAuth tokens cannot access claim, ERA or claim-mapping routes.
- Original ERA CRLF bytes survive the exporter; missing patient/payer/billing
  relationships and duplicate claim identities fail before package creation.

The running localhost web UI was exercised with synthetic Avery data: prepare
and release claim → record external submission and acceptance → load an original
835 file through the file picker → inspect exact claim and current balance →
select CO credit → reconcile → post → inspect ledger → reverse → verify restored
balance and retained entries. A $150 charge, $100 payer payment and $25 selected
CO credit left $25; reversal restored the $150 balance with append-only offsets.
The worklist now refreshes after lifecycle mutations, and claim detail shows the
reviewed packet diagnoses rather than the original account's empty coding list.


## 837P and clearinghouse file operations — 2026-10-23

All 21 PostgreSQL integration tests, 7 parser/generator unit tests and 15 Python
exporter tests pass. Formatting, Clippy with warnings denied, JavaScript syntax,
OpenAPI reference resolution and patch whitespace checks pass. New tests cover:

- Generated ISA width, matched controls and ST/SE count; integer-cent service
  totals without multiplying units; diagnosis pointers/modifiers; dependent
  hierarchy; replacement payer-control references; delimiter/consent/code guards.
- Immutable claim/profile/artifact snapshots, idempotent generation, cancellation
  without control reuse, exact byte download, stale partner/claim guards, tenant
  isolation and role/billing-scope enforcement.
- External handoff and claim status commit together; injected audit failure rolls
  both back; concurrent delivery recording succeeds once.
- Matching 999 acceptance does not accept the payer claim; technical rejection
  preserves the prior packet; wrong/partial/conflicting results remain reviewable;
  late technical evidence cannot overwrite accepted clinical billing state.
- ST/SE and wrapper control/count failures, unsupported/out-of-order 999 data,
  interchange-only TA1 evidence and retained manual review boundaries.
- Real migration staging/commit of partner and acknowledgment source kinds creates
  no active profile. Independent reconciliation links native test profiles/files
  and original 999 evidence. Known legacy X12 credential fields are rejected.
- Exporter allowlist excludes current and unknown future secret fields, validates
  claim/partner relationships and retains exact acknowledgment CRLF bytes.

Running-browser verification used synthetic Riley data from the prior financial
source import. Staff reviewed numeric CPT coding before posting the native source
account, released a native claim, reconciled an imported source system partner (historical
P usage did not silently become active production usage), and generated a test
837P file. The browser download's exact bytes and SHA-256 matched the immutable
artifact. Recording a simulated test handoff left technical/payer outcomes pending;
reconciling the original imported 999 changed only technical status to accepted;
separate simulated payer evidence then accepted the claim. No real external upload
or clearinghouse delivery occurred. The final screens retain all source mappings
and attributed event history.


## Automated delivery and 277CA milestone

Formatting, all-target Clippy with warnings denied, 37 Rust tests and 16 Python exporter tests pass. JavaScript syntax checks pass.

Local synthetic validation on October 23, 2026 covers the new HTTPS gateway
contract with an actual loopback HTTP server, durable queue leasing, stable
idempotency/payload hashes, confirmed nonreceipt retries, concurrent workers,
ambiguous receipt holds and expired-lease recovery. Injected delivery-result audit
failure rolls back claim/submission/job changes while preserving the already
committed lease; recovery holds for review without sending again. Current claims
are protected against mutation during an active send. Tenant/role restrictions,
version/replay guards and receipt reconciliation are exercised.

277CA tests cover hierarchy, qualified payer/intermediary controls, claim/service
statuses, mixed outcomes in multiple transaction sets, custom component delimiters,
envelope counts, unsupported/conflicting evidence and exact native reconciliation.
Wrong issuer, NPI, member, receiver, amount, date, service code or line control
cannot apply. Clearinghouse acceptance leaves the claim submitted; independently
reviewed payer acceptance records its payer control. Rejection does not fabricate
one. An injected row-apply audit failure rolls back the claim and review together.
Source migration preserves the original text and declared origin, links the native
document back to historical evidence and creates no claims or delivery jobs.

The running preview completed an actual loopback worker send for `Quinn Synthetic`,
recording a receipt after one attempt. A synthetic source system-style original 277CA was
imported through migration, staged in the inbox and applied by HTTP API with exact
member/NPI/payer/amount/date/service identity and current versions. The claim became
accepted with synthetic payer control `SYN-PAYER-LIVECA`; the original source and
row decision remain retained. No real clearinghouse or payer was contacted.

The new web assets are served by the preview and pass JavaScript syntax checks.
The browser tool rejected acquisition of the local preview under its URL policy,
so this milestone has no new visual screenshot or completed browser interaction
proof. The new GUI walkthrough is **unverified**; prior screenshots cover earlier
milestones only. Server/API behavior has independent automated and real HTTP proof.

See [automated delivery and 277CA](automated-delivery-277ca.md) for configuration,
transport contract and bounded parsing scope. Partner-native adapters, automatic
acknowledgment retrieval, external companion-guide acceptance, complete X12/ONC
conformance and complete native workflow support remain pending.

## Provider adapters and automated acknowledgment retrieval — October 24, 2026

Formatting and all-target Clippy with warnings denied pass. The regular Rust suite
passes 43 tests (33 connection/migration tests, seven library tests and three visit
contract/workflow tests). Three explicitly invoked OpenSSH fixture tests also pass,
for 46 Rust checks exercised locally. They remain ignored in ordinary test runs
because they need a disposable SSH server. Seventeen Python exporter tests and
JavaScript syntax checks pass. No real provider keys or patient records are used.

Stedi protocol tests verify raw Authorization, documented x12 JSON submission,
stable idempotency, exact returned claim control, initial clearinghouse-origin
acknowledgment retention, cursor pagination/deduplication, mode/direction filtering,
and original transaction retrieval. Signed-document requests omit the API key;
arbitrary hosts are refused. Claim.MD tests verify multipart upload, form ResponseID
polling, canonical per-message evidence, unknown-field exclusion and an identity-
reviewed status link that leaves the native claim unchanged. HTTP 200 with a
mismatched receipt cannot confirm delivery for either API adapter.

The two SFTP profiles run against real loopback OpenSSH using disposable host/client
keys, strict known_hosts verification and private workspaces. Both upload the exact
837P artifact and retrieve the original synthetic 277CA without deleting the remote
file. A wrong host key prevents upload and leaves uncertain delivery held without
automatic resend. The reproducible harness is:

```sh
TEST_DATABASE_URL=postgres://127.0.0.1:55473/suncharts_engine_test \
  python3 scripts/verify_provider_sftp.py --toolchain 1.99.1
```

Injected discovery audit failure preserves the old cursor and rolls back all new
observations; replay after lease expiry retrieves the page without losing reports.
Failed downloads hold after three read-only attempts. Owner pause prevents new polls
and downloads, with role/version/tenant boundaries checked. Historical provider
mapping is idempotent, atomically rolls back on audit failure, retains exact source
text, creates no claims/jobs, and cannot activate its historical mailbox.

A separate walkthrough against the running local binary completed four synthetic
provider journeys: Stedi API, Claim.MD API, Office Ally SFTP and Availity SFTP, each
with one delivery attempt. Five provider reports were retained. Independent native
277CA row review advanced the Stedi/Office Ally/Availity test claims to accepted;
linking the Claim.MD acknowledgment correctly left that claim submitted. The four
fixture connections were then explicitly paused. The new web assets are served.
These were local protocol fixtures, not provider-operated sandboxes or payer systems.

The prior browser-tool URL policy rejection still prevents an interactive GUI
walkthrough in this session. No new screenshot or visual acceptance is claimed.
Live enrollment, credentials, account-specific guides/naming/authentication,
password-only SFTP and full standards and clinical acceptance remain pending. See
[provider adapters](clearinghouse-adapters.md) for exact configuration and limits.

## Claim.MD ERA retrieval and automated staging — October 24, 2026

API 0.9.0 adds independent ERAID/Page discovery, credentialed original 835
retrieval, opt-in exact native staging, web workflow controls/outcomes/history,
and source system Claim.MD ERAID source mappings. Migration 0014 adds separate feed
state and immutable outcomes; no earlier committed migration was changed.

Validation on Rust 1.99.1 / PostgreSQL 16:

- 47 ordinary Rust tests pass, including four new Claim.MD ERA integration tests.
  The three separately provisioned real loopback OpenSSH tests also pass (50
  exercised Rust tests total). All-target Clippy denies warnings; fmt passes.
- 18 Python exporter/mapping tests pass; every web JavaScript asset passes Node
  syntax checks. API request/response schemas include automation provenance.
- New tests exercise actual form POSTs, independent status/ERA cursors, 101
  deliberately unsorted ERA IDs across provider pages, exact original hashes,
  bounded failed reads, mismatched download IDs, explicit retry, account-error
  recovery, tenant/role/version boundaries, pause, opt-in staging, concurrent
  workers, duplicate payer/trace holds, and reviewed posting/reversal.
- Injected audit failures roll back discovery/cursor advancement, downloaded
  originals, and native staging/link/outcome changes. Expired read leases replay
  without lost evidence or duplicate native packets. Automatic staging never
  writes a ledger entry or selects a CO credit.

The rebuilt engine at localhost:8090 was exercised through authenticated HTTP
against a local synthetic Claim.MD server. An ambiguous native payer-code case
correctly created a held outcome. A separate unique-payer fixture retrieved two
originals: the first progressed from discovery/download and automatic suggestions
through explicit staff matching, posting and reversal. The second remains a staged
packet with exact suggestions and no ledger posting, ready for web review. All
five synthetic provider connections were paused and automatic staging disabled
after the check. No real provider account or patient record was used.

The updated GUI assets and API 0.9.0 are served by the local engine. Interactive
visual QA remains unverified because of the previously reported browser local-URL
policy restriction; no workaround or screenshot acceptance is claimed. The
corresponding-source offer includes the new implementation, migration, tests,
API, web assets and documentation; the final running archive is checked against
the local source. External Claim.MD acceptance, broader 835 profiles/PLB,
unattended ledger posting, certification and complete native workflow support remain pending.

## Signed PLB and recoupment increment — October 24, 2026

API 0.10.0 expands the 835 model with signed provider adjustments, provider-only
settlements, reviewed provider cash entries, versioned recoupment follow-up cases,
exact-original CLP22 accounting recovery and source system PLB/reversal/AR mappings.
Migrations 0015–0016 add new tables and immutable source/history guards; prior
committed migrations are unchanged.

Verification uses only synthetic data:

- 51 ordinary Rust tests pass. The three real loopback OpenSSH tests also pass:
  54 exercised Rust tests in total. Rust 1.99.1 fmt and all-target Clippy with
  warnings denied pass. All web scripts pass Node syntax checks.
- 19 Python exporter/mapping tests pass, including signed PLB/reversal indexing,
  exact original retention, frozen AR-reference validation and malformed pairs.
- New native checks exercise provider-only zero-payment remittances, multiple
  signed pairs, fiscal dates, envelope component separators, exact balance,
  explicit classification, case actions/history, roles/tenants, immutable entries,
  and provider posting/reversal without patient-account allocation.
- CLP22 tests require exact original claims/CAS/services, current versions and a
  posted source; stale/wrong originals cannot reconcile. Recovery and undo of
  recovery retain offsets and restore accounting/lifecycle evidence. Dependent
  recovery blocks reversing the original. Injected provider-post audit failure
  rolls back both patient and provider ledgers, recovery links, case history and
  native state. Provider-only audit failure has the same atomic guarantee.

Authenticated HTTP checks against the rebuilt localhost:8090 engine parsed real
synthetic 835 text, posted an original payment, and recorded its exact CLP22
recovery with a negative WO offset. A later provider-only FB/WO settlement was
reviewed/posted, disputed, acknowledged, closed and reversed; patient-account
balance was unchanged by every provider-only operation. A replacement synthetic
provider settlement remains posted with a disputed case for preview review.
All synthetic connections remain paused; no provider server, real patient,
production database or external appeal submission was involved.

New web controls and API 0.10.0 are served locally. Interactive visual acceptance
remains unverified under the previously reported browser local-URL policy block.
The final rebuilt source offer is compared with the local implementation, web,
migrations, API, tests and docs. This milestone does not establish full 835/TR3,
payer-specific or ONC acceptance. Remaining transaction/profile and correction
sequence limits are explicit in claims-remittances.md.

## Multi-transaction files and correction chains — October 24, 2026

API 0.11.0 adds file preview/import, ordered batch review/post/undo, exact original
file and transaction slices, row-level ledger journals, active posting heads,
prior-head contexts, native source history and source system per-transaction mappings.
Migrations 0017–0019 are additive successors; prior committed migrations are unchanged.

Validation uses synthetic data and PostgreSQL 16:

- 56 ordinary Rust tests pass, including envelope/byte-slice parsing, repeated
  correction chains, native historical-file mapping and atomic multi-transaction
  posting. The three separate real loopback OpenSSH tests pass (59 exercised
  Rust tests total). Rust 1.99.1 fmt and all-target Clippy deny warnings.
- 20 Python exporter tests pass. Multi-file source mapping retains controls,
  offsets, signed PLB/reversal identities and source payer/AR references; malformed
  count/control/pair inputs are rejected. All web JavaScript passes Node checks.
- File parsing tests cover multiple interchanges, changed delimiters, exact source
  slices, duplicate controls, malformed envelopes and transaction limits.
- Accounting tests cover same-transaction reversal/correction, corrections split
  across transactions, changed payer claim controls, repeated cycles against
  corrected rows, recovery of an original restored by undo, and reverse-order
  unwinding back through the original. Stale/out-of-order dependencies cannot post.
- Two concurrent batch posts produce one success and one conflict. An injected
  final batch-post audit failure rolls back all rows, heads, recoveries, provider
  entries/cases and child statuses. Rollback-only reconciliation leaves no ledger
  rows. Individual child posting/reversal is blocked; original file mutation is
  blocked through ordinary SQL. Tenant isolation remains enforced.
- Historical original-file import is byte-exact and request-idempotent, links to
  one native batch, and creates no patient/provider balance or recoupment case.

The rebuilt localhost:8090 engine was checked through authenticated HTTP with a
synthetic two-transaction file containing three ordered rows: a positive correction
of an existing reversal, then its reversal and another correction. Posting changed
the account balance from 12550 to 2000 cents; whole-file undo restored 12550 and
the original active head. A second file remains reviewed for web inspection.
All provider connections remain paused and automatic staging remains disabled.
No real provider account, patient data or bank/appeal submission was used.

The GUI includes file upload/preview, explicit per-transaction payer selection,
source-row history/selection, correction links, ordered native review, file actions,
originals and attributed history. Uploaded/source CRLF bytes are retained outside
the textarea's normalized value until explicitly edited. Provider inbox and legacy
source mapping link into file review. Interactive visual acceptance remains
unverified under the earlier browser policy restriction. The final running source
archive is checked byte-for-byte against the changed source, API, migrations,
web assets, tests and docs. This is not a full TR3/ONC or native workflow support claim;
remaining profile limits are documented in era-files-corrections.md.

## Practice home and connected encounter workspace (API 0.12.0)

The October 25, 2026 integration adds a staff-only, tenant-scoped and audited
unfinished-encounter worklist. A single database query returns the oldest 100
unsigned encounters across all dates, their exact total and an explicit limit
flag. It exposes saved-state booleans rather than note/vitals contents. A new
PostgreSQL integration test verifies empty state, prior-date unfinished work,
tenant isolation, anonymous/patient denial, staff reading, saved-state changes,
removal after signing and the 101-row limit/count boundary.

Practice home consumes the real schedule, worklist and report-review inbox.
Unavailable data is distinct from zero work. Resume routes to the exact patient
and visit; report links open the correct native order. The patient encounter rail
connects longitudinal list review, vitals, saved/signature state, orders/results
and encounter-linked charges. Editing/signing controls follow the assigned
clinician boundary. OAuth consent retains priority over ERA links, then practice
home; initialization waits for deferred modules to load.

Validation for this increment:

- 57 Rust tests passed (10 library, 44 connection/migration, 3 visit tests).
  The 3 explicit loopback-SSH tests remain ignored by the ordinary suite and were
  not rerun for this workspace increment; their earlier evidence remains separate.
- Formatting and all-target Clippy with warnings denied passed.
- 20 Python exporter/mapping tests passed.
- `node scripts/test_practice_ui.cjs` passed all 3 fixture-only regression groups:
  encounter state/role controls, queue failure/escaping/routing and entry precedence.
  All web JavaScript files passed syntax checking.
- Authenticated localhost HTTP verified a real prior-day encounter appeared in the
  queue and disappeared after signing. A new synthetic patient retains saved
  vitals, a saved unsigned note, 3 explicitly reconciled empty clinical lists, a
  placed local order, received specimen and final unacknowledged result. Today's
  schedule contains booked, checked-in, in-progress and completed appointments.
  Served workspace assets matched the source files. No external provider was used.

The new dashboard/encounter screens have not passed interactive browser, visual,
accessibility or clinical usability acceptance. Node fixture tests and HTTP checks
are distinct from that work. No delegated nurse/MA role, administrative checkout,
general follow-up task persistence, expanded demographics or broader FHIR profile
was introduced. See [roadmap.md](roadmap.md) for the actual gaps and
parallel work packages; this increment does not establish native workflow support.

## Light clinical workbench and native contact details (API 0.13.0)

October 25, 2026: the shell now uses light navigation, distinct destination icons,
a context/date toolbar and a patient finder (Ctrl/Cmd+K). Practice overview uses
one dense patient workboard with agenda/unfinished tabs, actual status/search
filters, exact appointment-to-encounter resume links, and an independent results
queue with a critical-only filter. The chart uses compact encounter progression,
structured clinical/result/vitals/history summaries, and a Patient details tab.

Contact profiles are persisted through migration 0020 with tenant-scoped staff
reads, versioned owner/clinician/front-desk writes, immutable attributed history
and atomic audit. Unknown contact values remain null; MRN/legal name/DOB remain
separate. Two new PostgreSQL tests cover scope/roles, durable history, concurrent
versions, invalid input, direct SQL guards and injected audit failure rollback.

- 59 ordinary Rust tests passed: 10 library, 44 connection/migration, 2 contact,
  and 3 visit tests. The 3 explicit loopback SSH tests were not rerun for this UI/
  contact increment and remain separately documented prior evidence.
- Formatting, all-target Clippy with warnings denied, 20 Python tests, and all
  4 Node fixture regression groups passed. Fixture tests exercise actual filters,
  loaded-vs-total limits, exact patient/encounter routing, escaping, unavailable
  queues, documentation roles and OAuth/ERA/home precedence.
- Authenticated localhost HTTP verified contact version 0→1, normalized country,
  attributed history, stale version rejection, unchanged encounter note/version,
  and the worklist appointment/provider metadata used by agenda resume links.
  Shell, demographics, practice, chart JS and CSS served byte-identical source.

Interactive browser/visual/accessibility/clinical usability acceptance is still
unverified; these frontend changes are ready for user review, not accepted design.
The public-source readiness assessment is separate from
clinical certification, complete native workflow support, partner acceptance and production use.

## Public preview JWT dependency correction

During initialization of the public GitHub repository, Dependabot reported
GHSA-h395-gr6q-cpjc against jsonwebtoken 9.3.1. The release candidate uses 10.4.0
with AWS-LC selected, unused default/PEM features disabled, and explicit optional
not-before validation at the legacy gateway boundary. A regression exercises
malformed/null/object/negative/future not-before, malformed/missing expiration,
valid absent/past not-before and default-disabled legacy gateway authentication.
The focused regression passed, followed by the full 60 ordinary Rust tests and
all-target Clippy. Three explicit loopback SSH fixtures remain separate prior
evidence. Native C/CMake build requirements are documented. Hosted Linux validation
must be taken from the actual candidate run, not the earlier 4a50644 green run.
