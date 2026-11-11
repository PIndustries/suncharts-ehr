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
   exists. Recording a receipt does not charge a card. Live card capture is
   unavailable; hosted test payments are limited to development with synthetic data.
2. Open the encounter, document the visit and ICD-10 diagnoses, and enter its
   procedures and charges under **Procedures & CPT**. Review diagnosis links,
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
automatic responsibility allocation and live card capture remain unavailable in
this EHR workflow.

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

Files support ASCII up to 48,000 bytes, 1–20 transaction sets, at most 30 claim rows
and 120 PLB pairs per transaction. Multiple groups/interchanges with separate
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

Unsupported financial segments, unrecognized recovery chains and mismatched source
links require review. Local parser support is not proof that every payer's 835
profile is accepted.

## Hosted test payments

Payment settings use an authenticated SunCharts Payments connection backed by
Stripe Connect. **Live charges are disabled.** Test collection is available only
in development with synthetic patients. When `ENGINE_ENVIRONMENT=production`,
the EHR blocks test-payment activation, creation, refunds, and ledger
reconciliation. Historical payment evidence and account setup remain available;
simulated processor funds cannot reduce production patient balances. A correctly bound live Stripe account may display business, charge and payout readiness after a refresh. This authenticates the connection only and does not enable live collection.

For a connected installation, configure the clinic payment account from the
native SunCharts EHR billing experience. SunCharts Connect owns the Stripe
platform secret and brokers onboarding and Checkout creation/retrieval. The EHR
reconciles retrieved evidence; managed refund and webhook delivery contracts are
not yet supported. The clinic never enters a Stripe API key,
installation ID, or broker token in the EHR. Only Stripe-hosted identity and
bank verification opens outside the EHR, then returns to the clinic payment
account. Staff refreshes account status and explicitly activates test checkout
from the native billing experience. If status refresh fails or Stripe still needs
information, choose **Continue Stripe setup** to resume the clinic-scoped setup
page. This action stays available even when a previous refresh did not return an
onboarding link. Complete verification, return to the EHR and refresh again.

Managed payments use the verified Connect origin unless an operator supplies
`ENGINE_PAYMENT_BROKER_URL`. They require a verified installation and
completed clinic enrollment. Authorized clinic owners, delegated partner
administrators, and platform administrators manage the clinic-scoped account
from the EHR. Stripe onboarding is used only for required identity and bank
verification; selecting the option alone does not enable collection.

Create a hosted Checkout Session from a posted account using its current version,
a stable request UUID and an integer USD amount within the available balance.
Enter the reviewed copay or patient responsibility explicitly; the account
balance can include insurer responsibility and is not used as a default payment
amount. Pending attempts reserve their amounts. Card details are entered on Stripe-hosted
Checkout. The EHR sends generic payment details and opaque identifiers, not clinical
notes, diagnoses, names or MRNs.

A browser return never posts payment. Server retrieval or a verified signed webhook
checks processor identity, amount, currency, test mode and confirmed payment/refund
evidence before accounting. Duplicate evidence cannot post twice. Uncertain requests
retain their original identity; after the provider idempotency window they require
reconciliation rather than a new request.

Own-account mode supports native test refunds and session expiration. The managed
broker currently supports Checkout creation/retrieval and external-refund
reconciliation, so issue managed refunds in the connected Stripe account and
refresh the original attempt. Manual ledger reversals do not refund a card charge.

Live collection, disputes, payout/fee reconciliation, multiple currencies,
terminals and recurring charges remain unsupported. See [operations](operations.md)
for credential backups and [the API](../api/openapi.json) for exact contracts.
