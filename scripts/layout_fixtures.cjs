#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Real screen fragments for the visit billing card, so a headless layout checker can
// measure them. The markup always comes from web/visit-billing.js itself.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CSS_FILES = [path.join(ROOT, 'web', 'style.css'), path.join(ROOT, 'web', 'visit-billing.css')];

// web/visit-billing.js is loaded exactly as scripts/test_visit_billing_ui.cjs loads it:
// display-format.js first (index.html loads the staff display helpers before feature
// scripts), then the feature script, into a stubbed browser context.
function loadVisitBilling() {
  const { visitSummary } = require('./visit_billing_fixture.cjs');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const node = () => ({ innerHTML: '', dataset: {}, hidden: false, open: false });
  const ctx = {
    console, Date, Intl, URL, Map, Set, Array, Math, Number, String, JSON, encodeURIComponent,
    setTimeout: () => 0, clearTimeout() {},
    document: { addEventListener() {}, createElement: () => ({ setAttribute() {} }) },
    $: node,
    me: { role: 'front_desk' },
    selected: 'patient', chartSection: 'visits', encounterSection: 'charges',
    activeVisit: { id: 'visit', appointment_id: 'appointment', status: 'signed', version: 3 },
    workspace: { patient: { id: 'patient' }, demographics: { patient_id: 'patient', content: {} }, appointments: [], visits: [{ id: 'visit', appointment_id: 'appointment' }], billing: { accounts: [], coverages: [], entries: [], copays: [] } },
    esc,
    human: (v) => String(v).replaceAll('_', ' '),
    date: (v) => v,
    money: (v) => `$${(v / 100).toFixed(2)}`,
    dollars: (v) => (v / 100).toFixed(2),
    cents: (v) => Math.round(Number(v) * 100),
    payerName: () => 'Synthetic Medicare PPO',
    billingCan: () => true,
    showChartSection() {}, setEncounterSection() {}, notice() {}, run: (fn) => Promise.resolve().then(fn),
    api: async () => { throw new Error('layout fixtures never call the API'); },
    showBillingAccount() {}, showEncounterClaim() {}, claimEditor() {}, openBillingEditor() {},
    patientInvoiceDocument: () => '', loadHostedCopays() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'display-format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'visit-billing.js'), 'utf8'), ctx);
  return { card: ctx.visitBillingCardMarkup, visitSummary };
}

// Permissions a billing staff member holds on the open visit.
const CTX = { canCreate: true, canWrite: true, claimsAllowed: true };

// Every fragment below is produced by calling visitBillingCardMarkup with a state in the
// shape the server returns. States the card renders from its own copy are out of scope:
// 'sign_visit', 'prepare_claim', 'waiting_insurer', 'post_response', 'review_response',
// 'review_balance', 'patient_credit', 'claim_cancelled' and 'insurance_outside' add no new
// shape to measure. 'paid_in_full' is the one asked-for state the fixture module does not
// model, so it is written by hand in the same shape; it renders identically to the
// selfPay({state:'paid_in_full'}) form the UI test uses.
const noCharges = (visitSummary) => visitSummary({
  state: 'add_charges', account: null, charges_cents: null, balance_cents: null,
  claim: null, claim_count: 0,
  insurance: { insured: true, insurer: 'Synthetic Medicare PPO', electronic: true, status: 'not_billed', paid_cents: 0, adjusted_cents: 0, pending_cents: 0, unassigned_cents: 0, sent_on: null },
  patient: { copay_cents: null, copay_paid_cents: null, copay_due_cents: null, paid_above_copay_cents: null, received_cents: 0, receipts_applied_cents: 0, other_payments_cents: 0, other_patient_payments_cents: 0, adjustment_cents: 0, unapplied_cents: 0, overpaid_cents: 0, credit_cents: 0, receipt_needs_review: false, responsibility_cents: null, responsibility_source: 'not_final', owes_now_cents: 0 },
  receipts: [], statement: { current: false, latest_id: null, count: 0 }, timeline: [],
});

const chargesSaved = (visitSummary) => visitSummary({
  state: 'post_charges', account: { id: 'account', status: 'draft', version: 1, total_cents: 28000, service_date: '2026-11-12', has_visit: true },
  balance_cents: null, claim: null, claim_count: 0,
  insurance: { insured: true, insurer: 'Synthetic Medicare PPO', electronic: true, status: 'not_billed', paid_cents: 0, adjusted_cents: 0, pending_cents: 0, unassigned_cents: 0, sent_on: null },
  patient: { copay_cents: 1000, copay_paid_cents: 1000, copay_due_cents: 0, paid_above_copay_cents: 0, received_cents: 1000, receipts_applied_cents: 1000, other_payments_cents: 0, other_patient_payments_cents: 0, adjustment_cents: 0, unapplied_cents: 0, overpaid_cents: 0, credit_cents: 0, receipt_needs_review: false, responsibility_cents: 1000, responsibility_source: 'plan_copay', owes_now_cents: 0 },
  receipts: [], statement: { current: false, latest_id: null, count: 0 }, timeline: [],
});

const readyToPost = (visitSummary) => visitSummary();

// Long missing lists in all four groups. Codes are chosen so each item lands in its group
// deliberately rather than by a keyword coincidence.
const fixClaimIssues = [
  { code: 'billing_provider_name', missing: 'billing provider name', detail: 'The billing provider on the practice billing profile is blank.' },
  { code: 'billing_organization_tax_id', missing: 'billing organization tax ID', detail: 'Tax ID is required on the billing organization.' },
  { code: 'billing_address', missing: 'billing address', detail: 'The billing organization has no street address.' },
  { code: 'provider_npi', missing: 'provider NPI', detail: 'The rendering provider has no NPI on file.' },
  { code: 'taxonomy_code', missing: 'taxonomy code', detail: 'The rendering provider has no taxonomy code, so the claim box 24J would be empty.' },
  { code: 'patient_address', missing: 'patient address', detail: 'Patient street address is required.' },
  { code: 'patient', missing: 'patient phone', detail: 'Patient phone number is required.' },
  { code: 'policy_holder_address', missing: "policy holder's address", detail: 'Subscriber street address is required.' },
  { code: 'payer_name', missing: 'insurer name', detail: 'The plan has no payer name in the coverage record.' },
  { code: 'policy_holder_birth_date', missing: "policy holder's date of birth", detail: 'Subscriber date of birth is required.' },
  { code: 'member_id', missing: 'member ID', detail: 'Member ID is required on the coverage record.' },
  { code: '', missing: 'plan year is not supported', detail: 'The payer rejects this claim for the plan year on the coverage record.' },
];

const needsDetails = (visitSummary) => visitSummary({
  state: 'fix_claim', claim: { id: 'claim', status: 'draft', frequency: 'original', payer_name: 'Synthetic Medicare PPO', secondary: false, crossover: false, automatic: true, issues: fixClaimIssues, sent_on: null, response_to_review: null },
});

const selfPayOwes = (visitSummary, selfPay) => selfPay();

const paidInFull = (visitSummary) => visitSummary({
  state: 'paid_in_full', waiting_on: 'nobody', balance_cents: 0, claim: null, claim_count: 0,
  insurance: { insured: false, insurer: '', electronic: false, status: 'none', paid_cents: 0, adjusted_cents: 0, pending_cents: 0, unassigned_cents: 0, sent_on: null },
  patient: { copay_cents: null, copay_paid_cents: null, copay_due_cents: null, paid_above_copay_cents: 0, received_cents: 28000, receipts_applied_cents: 28000, other_payments_cents: 0, other_patient_payments_cents: 28000, adjustment_cents: 0, unapplied_cents: 0, overpaid_cents: 0, credit_cents: 0, receipt_needs_review: false, responsibility_cents: 28000, responsibility_source: 'self_pay', owes_now_cents: 0 },
  receipts: [{ id: 'receipt', appointment_id: 'appointment', amount_cents: 28000, method: 'card', occurred_on: '2026-11-20', voided: false, refunded_cents: null, needs_review: false, test: false }],
  statement: { current: true, latest_id: 'invoice', count: 1 },
  timeline: [],
});

const denied = (visitSummary) => visitSummary({
  state: 'denied', waiting_on: 'staff', balance_cents: 28000,
  insurance: { insured: true, insurer: 'Synthetic Medicare PPO', electronic: true, status: 'denied', paid_cents: 0, adjusted_cents: 0, pending_cents: 27000, unassigned_cents: 0, sent_on: '2026-11-12' },
  patient: { copay_cents: 1000, copay_paid_cents: 1000, copay_due_cents: 0, paid_above_copay_cents: 0, received_cents: 1000, receipts_applied_cents: 1000, other_payments_cents: 0, other_patient_payments_cents: 0, adjustment_cents: 0, unapplied_cents: 0, overpaid_cents: 0, credit_cents: 0, receipt_needs_review: false, responsibility_cents: 1000, responsibility_source: 'plan_copay', owes_now_cents: 0 },
  claim: { id: 'claim', status: 'adjudicated', frequency: 'original', payer_name: 'Synthetic Medicare PPO', secondary: false, crossover: false, automatic: true, issues: [], sent_on: '2026-11-12', response_to_review: null },
});

function fragments() {
  const { card, visitSummary } = loadVisitBilling();
  const { selfPay } = require('./visit_billing_fixture.cjs');
  const build = (fn) => fn(visitSummary, selfPay);
  const states = [
    ['no-charges', noCharges],
    ['charges-saved-note-unsigned', chargesSaved],
    ['ready-to-post', readyToPost],
    ['needs-details', needsDetails],
    ['self-pay-owes', selfPayOwes],
    ['paid-in-full', paidInFull],
    ['denied', denied],
  ];
  return states.map(([name, fn]) => ({ name, file: `visit-billing-${name}.html`, html: card(build(fn), CTX) }));
}

function selfTest(items) {
  const missingGroups = ['practice', 'patient', 'insurance', 'claim'];
  let checked = 0;
  for (const { name, html } of items) {
    if (typeof html !== 'string' || html.trim().length === 0) throw new Error(`${name}: fragment is not a non-empty string`);
    if (!html.includes('class="visit-billing-card"')) throw new Error(`${name}: no class="visit-billing-card"`);
    checked += 1;
  }
  const needs = items.find((item) => item.name === 'needs-details');
  if (!needs) throw new Error('needs-details fragment is missing');
  const grouped = missingGroups.every((group) => needs.html.includes(`data-missing-group="${group}"`));
  if (!grouped && !needs.html.includes('Fix claim details')) throw new Error('needs-details has neither all four data-missing-group lines nor the Fix claim details button');
  return checked;
}

function runChecker(items, outDir) {
  const checker = process.env.LAYOUT_CHECK || '';
  if (!checker || !fs.existsSync(checker)) { console.log('LAYOUT_CHECK not set; skipped'); return 0; }
  const { spawnSync } = require('node:child_process');
  let failures = 0;
  for (const { name, file } of items) {
    const args = [checker, '--html', path.join(outDir, file)];
    for (const css of CSS_FILES) args.push('--css', css);
    args.push('--widths', '1024,820,390', '--out', outDir, '--theme', 'dark');
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\s+$/, '');
    if (out) console.log(out);
    if (run.status !== 0) failures += 1;
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const items = fragments();
  if (args[0] === '--self-test') {
    const count = selfTest(items);
    console.log(`PASS ${count} fragments`);
    return 0;
  }
  const target = args[0];
  if (!target) { console.error('usage: node scripts/layout_fixtures.cjs OUTDIR [--check] | --self-test'); return 2; }
  const outDir = path.resolve(target);
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, file, html } of items) {
    if (typeof html !== 'string' || html.trim().length === 0) throw new Error(`${name}: fragment is empty`);
    fs.writeFileSync(path.join(outDir, file), html);
    console.log(path.join(outDir, file));
  }
  fs.writeFileSync(path.join(outDir, 'css.txt'), `${CSS_FILES.join('\n')}\n`);
  console.log(path.join(outDir, 'css.txt'));
  if (args.includes('--check')) return runChecker(items, outDir) === 0 ? 0 : 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`layout_fixtures: ${error.message}`);
  process.exitCode = 1;
}
