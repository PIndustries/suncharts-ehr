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
what the patient owes. Comprehensive responsibility allocation, automated
statements and financial close are not implemented. Configured Claim.MD
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
   procedures and charges under the encounter’s **Procedures (CPT/HCPCS) & billing** step. Review diagnosis links,
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

When entering charges, select saved encounter diagnoses inline on each procedure.
Selections copy codes for explicit review; new procedures have no default diagnosis
association. These copied codes are not provenance links and do not follow later
encounter edits. Existing manual codes remain available.

For versioned provenance, save an order or charge account as a draft linked to a native visit, then choose
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

The claim workspace separates **Preview claim**, **Submit electronically** and
**Track response**. The CMS-1500 preview is a review copy of frozen claim evidence,
not an official paper-submission form. It shows recorded units, modifiers,
diagnosis pointers and patient payments; unavailable attestations remain unfilled.
Printing does not submit a claim. **Review & submit to Claim.MD** opens the existing
submission review before staff explicitly queue delivery. Manual activity performed
outside SunCharts is recorded separately.

Transport delivery, technical acknowledgment, claim acceptance and payer adjudication
are distinct. Review TA1/999 evidence and matched 277CA rows with their control
identities; an HTTP success or mailbox transfer is not payer acceptance.

The current generator has a restricted professional-claim profile. It does not
provide complete payer companion-guide coverage, institutional/dental claims,
tertiary coordination, Medicare-as-secondary/MSP profiles, denials/appeals or
enrolled payer acceptance. The bounded commercial secondary profile is described below.
See `src/x12.rs` and the API contract for accepted fields and validation errors.

## Secondary insurance on the same encounter

Record each service once. Effective primary, secondary and tertiary policies are
shown together in encounter billing; the account retains its original posted
primary policy. After the primary claim is adjudicated and its remittance posted,
open **Review secondary billing** on that primary claim. Select the effective
secondary policy, review primary service paid units, and explicitly record the
EOB crossover and payer submission-timing review. The draft secondary claim uses
the same account and original services, while freezing its own payer/subscriber
identity and the primary payment, adjustments, control number and remittance date.
Preparing a claim creates no ledger charge, patient liability or payment.

This path requires a native delivered primary electronic artifact and an active,
posted primary 835 row with exact ordered service controls and balanced charges,
payment and CAS adjustments. CLP19 means the primary payer reports forwarding the
claim and blocks another outbound secondary claim. Missing or unsupported evidence
remains a review blocker. Existing secondary originals must be opened or corrected;
they cannot be duplicated. Reversal of primary adjudication is blocked while a
non-void downstream secondary claim depends on it.

The supported 837P secondary profile is a commercial destination (filing indicator
CI), with 2320/2330 prior-payer identity and 2430 service adjudication. Primary and
secondary payer IDs are frozen separately; the primary is not sent again. Native
Claim.MD submission still requires explicit review and queuing. Secondary CMS-1500
preview is unavailable and is refused rather than rendering incomplete other-payer
fields; the frozen JSON evidence and reviewed electronic artifact remain available.
Manual/external primary adjudication, tertiary claims and MSP destinations require
separate supported workflows and are not inferred by this path.

Post the secondary payment to the same account. OA23 and other prior-payer impact
remain evidence; PR does not create another charge. Already-posted primary CO
credits are visible in remittance review. Selecting a secondary CO adjustment with
the same reason and service scope as a posted primary credit is refused for review,
even when the remaining balance could absorb it. Determine the final patient share
from the reviewed secondary response before issuing a patient invoice.

Claim.MD documents using the [same submission API for secondary claims](https://docs.claim.md/docs/is-there-a-separate-api-for-submitting-secondary-claims)
and [reviewing crossover and payer timing before submission](https://docs.claim.md/docs/how-do-i-handle-secondary-and-tertiary-claims).
CMS identifies prior insurance in [837P loops 2320–2330G](https://www.cms.gov/Outreach-and-Education/MLN/WBT/MLN4462429-MLN-WBT-1500/1500/lesson04/23/index.html).
These references do not establish payer enrollment or acceptance of a particular claim.

### Received secondary crossover responses

When the posted primary835 reports CLP19, **Review secondary billing** does not
create another outbound claim. It offers an explicit link only after an actual
secondary835 has been imported or retrieved. Until then, it shows that a verified
secondary response is awaited; forwarding status alone does not identify its payer.

The bounded linkage profile requires the retained original835 and current active
secondary coverage with matching payer ID, N1 PE/XX billing NPI, original primary
patient-control number, secondary payer claim number, DTM472 service date, and
ordered original service controls, procedure/modifiers and charges. Paid and CAS
totals must balance. CLP2, CLP20 and CLP4 secondary responses are supported; missing
or differing evidence remains unlinked for review. A native delivered primary
artifact and its current posted CLP19 source are still required. This does not
infer provider identity from a deposit payee or infer a secondary destination from
Medicare forwarding alone.

After staff confirms the linkage, one tracking-only secondary record freezes both
sources on the same account. Its API status `submitted` identifies received
secondary evidence; the UI labels it **Crossover response received**, and SunCharts
has not transmitted anything. The record cannot be marked ready, exported as a
packet/CMS-1500/837, queued or marked delivered. Review the linked remittance and
post it separately; creation itself does not change charges, payments or liability.
A denied CLP4 with zero payment and no PR evidence neither creates new patient
responsibility nor clears the prior balance. Patient invoices require explicit
reviewed responsibility, including after a denial.

The first posting must use the exact bound remittance row and source hash. Later
corrections follow the existing reviewed reversal chain. Reverse an active secondary
posting before withdrawing an incorrect crossover link, then resolve its non-void
descendants before reversing the primary. An unposted withdrawn link retains its
history; its still-unposted source can be linked again after clearing any saved
match. A previously posted/reversed source is not silently reused as a fresh
crossover. Request replay returns the same record, and active source/payer bindings
cannot be duplicated.

CMS documents the forwarding meanings of CLP19 and CLP20 in its
[Medicare Remit Easy Print guide](https://www.cms.gov/Research-Statistics-Data-and-Systems/CMS-Information-Technology/AccesstoDataApplication/Downloads/Medicare-Remit-Easy-Print-User-Guide-Version44.pdf).
The forwarding code is evidence of processing status, not proof of a particular
secondary payer's receipt or payment.

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

The encounter's **Procedures (CPT/HCPCS) & billing** step and pre-visit **Insurance** tab can open
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

## Reviewed practice fee schedules

Practice owners can open **Practice administration → Practice fees**, load a
locally prepared numeric reference proposal, and save an **inactive draft**.
The owner chooses the provider, service facility, facility/non-facility setting,
verified QP basis, locality, practice multiplier, code scope and service-date
range. Source URLs, SHA-256 hashes, publication dates, exact code/modifier rows
and reference amounts remain attached to the proposal. No Medicare dataset or
CPT descriptions are bundled with the EHR. A source reference does not establish
coverage, medical necessity or the amount an insurer will pay.

Saving a proposal does not activate prices. Review the complete entries and
source evidence, acknowledge the scope and approve the current version with a
reason. Proposals and entries are immutable; correct them by preparing a new
proposal. Two approved schedules cannot overlap for the same provider, facility,
setting and service dates. Retiring a schedule stops new fee selection while
preserving its history and all previously captured charge evidence. A changed
provider or facility directory record requires a replacement reviewed proposal.

The charge form uses one fee context for its service lines. The provider comes
from the linked encounter; a facility is preselected only when the saved
appointment facility name exactly matches one active directory entry. The
service setting is preselected only from an explicitly approved default for that
scope. Otherwise staff select it. Fee lookup requires billing-view permission and
an exact approved code, modifier, date and scope match. Blank, professional and
technical component modifiers are distinct; no fallback or reduction policy is
inferred for unmatched modifiers.

Only new empty amounts, or untouched new lines already filled by the fee engine,
receive automatic prices. Unit price times units becomes the complete line
total; billing never multiplies that total again. Existing draft and posted
charges are not repriced. Staff can check and explicitly use a current approved
fee or retain a reviewed manual amount. Changing an approved amount requires an
override reason; the server records both expected and actual amounts with source
provenance. Selecting manual pricing for a different code retains the entered
amount; prior saved evidence remains in account history. Client-provided fee
snapshots are never accepted as authority. Fee lookup and approval create no
ledger activity, patient liability, payment or claim submission.

Printed patient invoices and copay receipts use the practice identity and a
readable print layout, with a discreet SunCharts footer. An invoice always keeps
its saved practice name, service details and monetary snapshot. Its current
practice logo is shown only when the saved practice name matches the current
practice identity, and is identified as current branding; older invoices are not
rewritten. Receipt copies use the current chart context as stated on the copy.
Logos reuse only the server-approved immutable branding asset already present in
the EHR, with an exact asset URL policy and no referrer. No patient identifiers,
amounts or document content are added to an image request. Missing or mismatched
logos fall back to the practice name. Test, refund, void and correction notices
remain visible on printed copies.
