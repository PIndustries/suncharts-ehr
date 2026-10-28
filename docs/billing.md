# Billing, claims and remittances

## Coverage and accounts

Create payer records, record patient coverage and review subscriber/member details
and effective dates. Coverage verification is a staff attestation, not a 270/271
eligibility response.

Create an encounter-linked charge account, review codes and amounts, then post it.
Accounting uses integer cents and append-only entries. Reversals append opposite
entries; they do not delete the original. Charges, payments, adjustments and claim
state remain separate from clinical signing and administrative checkout.

Patient responsibility must be reviewed. An account balance alone does not establish
what the patient owes. Fee schedules, comprehensive responsibility allocation,
statements, financial close and electronic eligibility are not implemented.

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

Payment settings offer a practice's own Stripe test account or an authenticated
SunCharts Payments connection backed by Stripe Connect. **Live charges are disabled.**

For an own account, save a `sk_test_` or `rk_test_` key, test authentication and
explicitly activate test checkout. Saving changes disables new collection. A webhook
signing secret is optional; without one, staff refreshes status explicitly.

Managed payments require `ENGINE_PAYMENT_BROKER_URL`, a verified installation and
completed owner enrollment. The owner completes setup through the authenticated
SunCharts payment page and Stripe onboarding; selecting the option alone does not
create a connected account.

Create a hosted Checkout Session from a posted account using its current version,
a stable request UUID and an integer USD amount within the available balance.
Pending attempts reserve their amounts. Card details are entered on Stripe-hosted
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
