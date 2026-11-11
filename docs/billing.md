# Billing, claims and remittances

## Coverage and accounts

Open the patient's **Insurance** tab to review coverage, subscriber/member details,
effective dates and the recorded plan copay for the selected appointment. Choose
the appointment explicitly when reviewing a different service date. Coverage
verification is a staff attestation, separate from a native Claim.MD eligibility
response. The latest eligibility check shows its request date, service date and
status; **View eligibility report** opens the retained structured response.
**Payer response received** means the request completed, not that benefits are
active or payment is guaranteed. Review the response before deciding what to collect.

Create an encounter-linked charge account, review codes and amounts, then post it.
Accounting uses integer cents and append-only entries. Reversals append opposite
entries; they do not delete the original. Charges, payments, adjustments and claim
state remain separate from clinical signing and administrative checkout.

Patient responsibility must be reviewed. An account balance alone does not establish
what the patient owes. Fee schedules, comprehensive responsibility allocation,
automated statements and financial close are not implemented. Configured Claim.MD
eligibility inquiries are supported; payer enrollment and returned benefits still
require review.

## Copay, patient invoice and insurance claim

1. Review insurance and the applicable copay for the appointment. **Record received
   copay** records confirmed cash, check or an external payment already received.
   Supply its amount, date, method, reference and evidence; check/external receipts
   require a reference. This can happen before an encounter or posted account
   exists. Recording a receipt does not charge a card. **Collect card copay** uses
   the separately configured hosted checkout described below; test-mode collections
   are limited to development with synthetic data.
2. Open the encounter, document the visit and ICD-10 diagnoses, and enter its
   procedures and charges under the encounter’s **Billing & claim** step. Review diagnosis links,
   quantities and full line totals before signing and posting. Posting applies
   available copay credit from this appointment to its account. A receipt recorded
   after posting can apply immediately. Pending processor attempts reserve amounts;
   allocation never exceeds the available account balance.
3. **View / print receipt** produces a patient copy with the received amount,
   method, reference, linked appointment and current allocation state. Unapplied
   credit remains visible until charges exist. **Apply recorded copay credit**
   allocates eligible remaining credit from the posted account. An unallocated
   receipt can be corrected by voiding its record; this does not refund money.
   Once allocated, use **Review ledger** and correct the original ledger entry.
   A reversal preserves the original evidence and prevents silent reapplication
   of that receipt. Refund movement must be handled separately.
4. Choose **Build patient invoice** on the posted account. Enter total reviewed
   patient responsibility before patient payments and credits, with its evidence.
   The server subtracts net recorded patient ledger activity, including reversals
   and refunds, without treating the gross insured balance as patient responsibility.
   A stale account version requires a reload. Saving retains an immutable, audited
   snapshot and does not collect money, email a bill or submit insurance.
5. Open **Saved patient invoices** to print or save a PDF. New snapshots include
   itemized services, codes, quantities, full line totals and patient payment
   activity, with separate payment and adjustment subtotals. They do not include
   internal staff evidence notes. Amounts describe the ledger at issuance; confirm
   the current ledger before requesting payment. Older saved invoices keep their
   original totals and explicitly state when itemization was not saved; current
   charges are never substituted into a historical invoice.
   Snapshots containing test processor activity are marked TEST. A later corrected
   snapshot does not add another charge to the ledger.
6. Create/review the insurance claim after recording the copay. The claim freezes
   the gross charge and net patient payments independently. Copay reversals and
   confirmed managed refunds reduce net patient payments. Review the claim, mark
   it ready and explicitly submit through the clinic's active Claim.MD connection.
   A later payment does not rewrite a previously frozen claim snapshot.

The selected encounter's revenue summary links its current claim and remittance
evidence. **Insurance claims** also supports patient- and account-filtered lists.
Review the claim response and post reviewed ERA evidence before determining the
remaining patient responsibility; charge posting or clearinghouse acceptance
alone does not complete this work.

Patient invoice snapshots are independent of Stripe account setup. They are not
Stripe-hosted invoices or automatic collection requests. Online invoice delivery,
and automatic responsibility allocation remain unavailable. Hosted appointment
copay collection is a separate operation with its own receipt and reconciliation.

## Encounter diagnosis links

Save an order or charge account as a draft linked to a native visit, then choose
**Link encounter diagnoses**. Select the saved encounter diagnoses supporting the
order or each charge line and record a reason. The server checks both the draft
version and encounter version before capturing diagnosis IDs, codes, descriptions
and encounter-version provenance. Later encounter edits do not rewrite snapshots.

Charge selections add canonical encounter codes while retaining existing manual
codes. Clearing selections clears provenance only; charge codes remain for explicit
manual review. Clear draft links before changing charge lines or the linked visit.
Placed orders and posted accounts keep their captured links immutable. Terminology
lookup, clinical necessity decisions and external submission remain separate.

## Claims and acknowledgments

Prepare a claim from a posted account, review the professional claim packet and
generate its supported 837P profile. Release and queue delivery explicitly.
Configure a [clearinghouse connection](clearinghouses.md) before transport.

Transport delivery, technical acknowledgment, claim acceptance and payer adjudication
are distinct. Review TA1/999 evidence and matched 277CA rows with their control
identities; an HTTP success or mailbox transfer is not payer acceptance.

The current generator has a restricted professional-claim profile. It does not
provide complete payer companion-guide coverage, institutional/dental claims,
secondary/tertiary coordination, denials/appeals or enrolled payer acceptance.
See `src/x12.rs` and the API contract for accepted fields and validation errors.

## ERA posting

1. Import an original 835 or open a retrieved provider report.
2. Match its payer and native claims, then review amounts, services and adjustments.
3. Reconcile against current claim/account versions.
4. Post only after review. Posting applies ledger, claim and provider-settlement
   effects together; a failed validation or audit rolls back the transaction.
5. Reverse through the remittance/file workflow when required. Original entries
   remain in the journal.

A CLP22 reversal identifies the exact original positive posting row. A positive
correction references its preceding reversal. Corrections cannot skip a newer
active posting or fabricate a payer-control identity. Reversals mirror the original
payment and selected credits rather than treating adjustments as new payments.

PLB adjustments use a provider settlement ledger and reviewed recoupment cases;
they do not automatically become patient debt. Provider-case completion does not
send an appeal or establish a bank settlement.

### Multi-transaction files

Files support ASCII up to 1 MiB, 1–100 transaction sets, at most 1,000 claim rows
and 1,000 PLB pairs per transaction, with a 100,000-segment file limit. Multiple groups/interchanges with separate
delimiters and unwrapped ST/SE sequences are supported. Envelope counts and control
identities are validated; parse errors reject the entire import.

Original bytes and exact transaction slices are retained. Select a matching payer
for each transaction, review its rows and provider adjustments, then reconcile the
file. Reconciliation simulates the ordered accounting plan without committing
its projected ledger effects.

Posting requires the current batch version and exact reconciled child-version
list. Any intervening change blocks the whole operation. Child transactions cannot
be posted independently. Undo processes transactions and rows in reverse order;
later dependent corrections must be undone first. SHA-256 and request identities
prevent duplicate import while preserving exact retries.

AMT, QTY, TS2, TS3, MIA and MOA supplemental fields are retained with their
claim/service scope for review. Their amounts do not create additional ledger
entries or bypass CLP/CAS/SVC and BPR balancing. Unknown segments, malformed
supplemental values, unrecognized recovery chains and mismatched source links
remain blocked. Payer identity uses a unique Loop 1000A REF*2U; an explicit legacy
N1*PR qualifier PI is supported when REF*2U is absent. Plan identifiers (XV) and
payee/claim references never substitute for a payer ID, and conflicting payer IDs
are rejected.

A valid settlement may leave a patient credit backed by existing net patient
payments/credits. It never adds PR as a second charge. The remittance displays the
current account credit; a new reviewed invoice displays the credit at issuance.
Insurer overpayment beyond those patient credits remains blocked. All claim rows
and provider adjustments still require review before atomic posting; this release
does not enable partial posting or automatic posting. Local parser support is not proof that every payer's 835
profile is accepted.

## Hosted appointment copays

The encounter's **Billing & claim** step and pre-visit **Insurance** tab can open
Stripe-hosted Checkout for a reviewed appointment copay before charges exist.
The appointment, patient, optional coverage snapshot, amount, installation,
credential revision, Stripe account and test/live mode are bound to that attempt.
Only opaque identifiers and generic payment descriptions are sent to the broker;
clinical notes, diagnoses and MRNs are not Checkout line items.

Live collection is disabled by default. It requires the EHR operator setting
`ENGINE_HOSTED_COPAY_LIVE_ENABLED=true`, the Connect operator setting
`SUNCHARTS_CONNECT_LIVE_CHECKOUT=enabled`, and a verified live account whose Stripe `card_payments` capability is active.
General charge readiness alone does not establish card acceptance; existing
settings require a fresh account-status check. These flags do not complete Stripe onboarding or attest to deployment
acceptance. Test mode is always blocked in production, including reconciliation
and allocation of old test receipts. Development test receipts are marked TEST.

The background worker reconciles durable attempts after browser closure and
process restart. Opening Checkout, returning from Stripe or receiving an uncertain
response does not create a payment. The server retrieves the exact original
account's Checkout Session, PaymentIntent and captured charge, checks their
identity, amount, currency, mode and capture timestamp, then creates one immutable
receipt with audited allocation. An exact retried request reuses its operation;
conflicting retries fail. Uncertain creations retry only inside the verified
23-hour provider idempotency window and otherwise require review.

A captured copay remains unapplied until eligible encounter charges are posted.
Its receipt is allocated once, without treating the gross insured charge as final
patient responsibility. Verified cumulative refunds consume unapplied credit
first and append reversals to prior allocations when needed. Duplicate evidence
cannot post twice. The receipt retains the processor capture date; refund ledger
dates reflect reconciliation because the broker supplies cumulative refunded
amounts rather than individual refund timestamps. Disputed or inconsistent
provider evidence stays in review.

Issue a managed refund in the connected Stripe account, then refresh the original
attempt or allow the worker to reconcile it. This EHR protocol does not initiate
managed refunds. Manual receipt voids and ledger reversals cannot alter hosted
funds. Existing ledger entries and saved invoices are never overwritten.

## Payment account setup

Payment settings use an authenticated SunCharts Payments connection backed by
Stripe Connect. Connect owns the platform secret and brokers clinic onboarding.
The clinic never enters a Stripe API key, installation ID or broker token in the
EHR. If status refresh fails or Stripe needs more information, **Continue Stripe
setup** resumes the clinic-scoped setup page even when the failed refresh did not
return an onboarding link. Complete Stripe's verification, return to the EHR and
refresh again. Charge capability and bank-payout capability are displayed
separately; connection alone does not establish either.

Managed payments use the verified Connect origin unless an operator supplies
`ENGINE_PAYMENT_BROKER_URL`. A verified installation and completed clinic enrollment
are required. Authorized clinic owners and delegated administrators manage the
clinic-scoped account from the EHR.

## Legacy posted-account test payments

The older posted-account payment routes remain test-only. Their explicit test
activation is separate from hosted appointment copays. Production blocks test
activation, creation, refunds and reconciliation. Read-only historical evidence
and onboarding remain available. A correctly bound live account can display
readiness without enabling this older payment path.

Create a test session from a posted account using its current version, a stable
request UUID and a reviewed USD amount within its available balance. The full
account balance may include insurer responsibility and is not a default patient
payment. Own-account mode supports test refunds and session expiration; the
managed legacy broker supports creation/retrieval and external-refund evidence.

Payout/fee reconciliation, dispute resolution, multiple currencies, terminals and
recurring charges remain unsupported. See [operations](operations.md) for
credential backups and [the API](../api/openapi.json) for the separate contracts.
