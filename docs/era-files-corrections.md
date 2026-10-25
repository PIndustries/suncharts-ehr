# Multi-transaction ERA files and correction chains

API 0.11.0 adds an original-file review workflow alongside individual remittances.
The supported file profile is ASCII up to 48,000 bytes, 1–20 835 transaction sets,
up to 30 claim rows and 120 PLB pairs per transaction. Multiple functional groups,
multiple interchanges with separate delimiters, and unwrapped ST/SE sequences are
supported. Controls must be unique in their envelope scope; nesting, ST/SE counts,
GE counts/control, IEA counts/control and supported HP/X221 groups are checked.
Every original byte is retained, including inter-transaction whitespace. Native
remittances retain exact transaction slices, and the parent retains ISA/GS/ST
controls, T/P usage and byte offsets. Parse errors reject the complete import.

## Web workflow

Claims & remittances includes **835 transaction files → Import 835 file**.
The ordinary ERA import editor can also preview its source as a transaction file.
Retrieved multi-transaction provider originals open file import; a linked provider
report opens its native batch. Historical legacy sources expose the parent batch
rather than pretending each transaction has a separate original file.

1. Load/paste the exact original and validate envelope/transaction boundaries.
2. Select a native payer for each transaction, in source order. Its payer code
   must exactly match the parsed transaction. Supply an attributed import reason.
3. Open each native transaction and review its claim rows and PLB pairs. Inspect
   the native claim/current account balance and select an exact original posting
   from its ERA history. History includes the active posting head. Explicit fields
   also allow source UUID/row selection for planned reversals earlier in this file.
4. CLP22 references the exact original positive posting row. A positive correction
   explicitly references the active preceding reversal, including a reversal in
   the same transaction or an earlier transaction in the file. The web UI uses
   1-based rows; API indexes are zero-based. Corrected payer claim-control numbers
   may change only through that explicit reversal/correction link.
5. Save each transaction's matches and provider review. Later transactions may
   remain staged individually because their preceding reversal is not posted yet.
6. Return to the file and reconcile it. The engine simulates the source-ordered
   plan in a database savepoint and rolls it back. No projected ledger, claim,
   provider-case or audit changes from simulation are committed. Only the attributed
   file review and successful child reconciliation/version changes persist.
7. Post the reviewed file. Current batch version and the exact reconciled child
   version vector are required. Any edited match/provider review, external payment,
   lifecycle change, invalid source or failed audit blocks/rolls back the complete
   posting. Native transactions cannot be individually posted or reversed.
8. Reverse a posted file from file review. Transactions and their rows unwind in
   reverse source order. Later dependent corrections must be undone first.

The UI retains originals, transaction controls, per-transaction source IDs, review
findings, source links and immutable file history. The most recent 100 file imports
are listed; API detail returns the current ordered version vector. An import has
no transport/clearinghouse side effects, and case follow-up does not send appeals.

## Accounting and correction invariants

Row journals associate each original payment/credit/recovery entry with exactly
one ERA claim row. An active-head projection identifies the current posting row
for each native claim and its current version. Immutable posting contexts retain
the preceding head. This permits repeated correction cycles against a previously
corrected row, and permits reversing a recovery and later recovering the restored
original without reusing an already-reversed ledger entry.

Reversals mirror the original charge, payment, PR, CAS groups/reasons/scope and
services. The source payer, native claim/account and active head must match, with
no downstream replacement claim. Actual original payment and selected CO-credit
entries are offset; unselected source adjustments never become new credits.
Corrections follow their exact reversal and require separately reviewed CO credits.
Missing/ambiguous/forward source links, duplicate row matches and positive payments
without a valid lifecycle cannot post. Claim/account baselines remain the versions
reviewed before the ordered plan; within-plan version advances are server-derived.

Undo walks each row's ledger reversal chain to its currently active leaves,
appends opposite entries and restores the preceding head/claim state. No original
entry is edited or deleted. This avoids double reversing entries when a recovery
was itself reversed. Provider settlement entries and case void/history remain
atomic with claim/account effects. Payer/trace duplicates across receipts are
blocked; distinct transactions in the same file may share an EFT trace without
changing the trace itself. A file SHA-256 prevents duplicate file import and a
request ID permits exact retry but rejects changed request evidence.

## Legacy mappings

The ERA exporter retains the original file once and adds
`settlement_mapping.transactions`: position, ISA/GS/ST controls, usage and exact
byte offsets, with PLB pairs and CLP22 source identities indexed inside each
transaction. Flattened legacy PLB/reversal indexes retain transaction_position.
Optional `transaction_payer_source_ids` in the file manifest must match the number
of transactions and reference already-exported payer sources. Native activation
still requires explicit exact native payers. Existing frozen AR session/activity
references remain historical and cannot recreate a payment automatically.

A historical file maps to one native batch via an immutable source link. Import
requires byte-for-byte equality with that source original; a source already mapped
to an individual remittance cannot be remapped as a batch (or vice versa).
Migration cutover remains disabled. No attachment export, bank settlement,
credential migration, live cursor activation or automatic old-payment posting is
implied.

## Implementation and remaining boundary

Migrations 0017–0019 add row journals, active heads, immutable prior-head contexts,
file records/items/events and scoped receipt-part identity. Existing unambiguous
postings are backfilled; ambiguous legacy states remain held for reconciliation.
Preview and actual execution share the same accounting planner. All financial
writers use the tenant billing lock. OAuth billing scopes and existing staff roles
apply; read/history APIs remain tenant-scoped. Originals/history are immutable.

The profile still holds unsupported supplemental financial segments, debit/net
negative BPR, non-USD documents, mismatched/partial reversals and unreviewed provider
adjustments. This milestone does not claim every payer companion-guide convention,
TR3 certification, live-provider acceptance, complete native workflow support, or ONC status.
The original single-remittance API remains available; multi-transaction files use
the batch API to preserve their envelope and ordered accounting semantics.

Primary references reviewed October 24, 2026:
[X12 reversal/CAS interpretation](https://x12.org/resources/requests-for-interpretation/rfi-1429-cas-required-backed-out-cla),
[X12 recovery interpretation](https://x12.org/resources/requests-for-interpretation/rfi-1976-overpayment-recovery).
These inform protocol handling; no licensed guide or source system implementation was
copied into the engine.
