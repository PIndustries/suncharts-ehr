// SPDX-License-Identifier: AGPL-3.0-only
// ENCOUNTER_TEST_URL=http://127.0.0.1:8095 node scripts/check_encounter_scroll_browser.cjs
'use strict';

const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const {selfPay, visitSummary} = require('./visit_billing_fixture.cjs');

const origin = new URL(process.env.ENCOUNTER_TEST_URL || 'http://127.0.0.1:8095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local preview');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id: id(11), tenant_id: id(12), role: 'owner', display_name: 'Synthetic clinician', email: 'staff@example.invalid'};
const patient = {id: id(21), given_name: 'Avery', family_name: 'Example', mrn: 'SYN-21', birth_date: '1990-01-01', status: 'active'};
const draftText = 'Synthetic draft stays here during section navigation';
const instructionsDraft = 'Synthetic patient instructions stay here while reviewing the encounter.';
const roomingComplaint = 'Synthetic allergy follow-up';
const date = '2026-11-24';
const appointment = {id: id(41), patient_id: patient.id, clinician_id: staff.user_id, title: 'Synthetic office visit',
  starts_at: date + 'T17:00:00Z', ends_at: date + 'T17:30:00Z', status: 'completed'};
const visit = {id: id(31), patient_id: patient.id, clinician_id: staff.user_id, encounter_number: 7,
  appointment_id: appointment.id, version: 1, status: 'in_progress', created_at: appointment.starts_at,
  note: {subjective: 'Synthetic complaint'}, vitals: {}};
const patientPath = '/api/v1/patients/' + patient.id;
const visitPath = '/api/v1/visits/' + visit.id;
const roomingPath = visitPath + '/rooming';
const codesDialog = 'dialog[data-encounter-codes-dialog][open]';
const noteSelector = '#note-form textarea[name="subjective"]';
const list = items => ({items, total: items.length, next_cursor: null});
const chargeCents = 18000;
const accountId = id(51);
const correctionPath = patientPath + '/billing/accounts/' + accountId + '/corrections';
const coverageId = id(61);
const claimId = id(71);
const receipt = {id: id(81), patient_id: patient.id, appointment_id: appointment.id, allocated_cents: chargeCents,
  amount_cents: chargeCents, account_ids: [accountId], method: 'cash', occurred_on: date, voided: false};
const diagnosis = {id: id(91), code: 'J30.9', display: 'Allergic rhinitis, unspecified', rank: 1};
const procedure = {code: '99213', description: 'Established patient office visit', amount_cents: chargeCents,
  units: 1, modifiers: '', diagnosis_codes: [diagnosis.code], service_from: date, service_to: date, code_system: 'CPT'};

function encounterBilling(currentVisit, scenario, correction) {
  if (scenario === 'handoff') {
    const b=encounterBilling(currentVisit,'draft-insured',correction);
    b.coverages[0].content.relationship='self';
    b.accounts[0].content.lines=[procedure];
    if(currentVisit.status==='signed'){
      b.accounts[0].status='posted';
      b.claims=[{id:claimId,status:'ready',payer_name:'Synthetic PPO',frequency:'original',issues:[]}];
      b.summary.claim=b.claims[0];
      b.summary.state='send_claim';
      b.summary.claim_handoff={outcome:'queued',claim_id:claimId,submission_id:id(150),job_id:id(151),delivery_status:'queued'};
    }
    b.summary.account=b.accounts[0];
    return b;
  }
  if (scenario === 'draft-insured') {
    const billing = encounterBilling(currentVisit, 'insured', correction);
    const copays = Array.from({length: 5}, (_,i) => ({...receipt, id: id(110 + i), amount_cents: 2500,
      method: 'card', allocated_cents: 0, created_at: date + 'T12:0'+i+':00Z', hosted_checkout: {status: 'paid', livemode: false, refunded_cents: 0}}));
    billing.copays = copays;
    billing.accounts[0].status = 'draft';
    billing.accounts[0].content.lines=[{...procedure,code_system:'HCPCS',code:'J0585',description:'Synthetic drug line'}];
    Object.assign(billing.coverages[0].content,{status:'active', effective_date:date, copay_cents:2500});
    billing.claims = [];
    billing.summary = visitSummary({...billing.summary, state: 'sign_visit', claim: null, account: billing.accounts[0],
      insurance: {status: 'not_billed', pending_cents: 0}, receipts: copays.map(r=>({id:r.id, appointment_id:r.appointment_id,
        amount_cents:r.amount_cents, method:r.method, occurred_on:date, refunded_cents:0, voided:false, test:true})),
      patient: {copay_cents:2500, copay_paid_cents:2500, copay_due_cents:0, received_cents:12500, unapplied_cents:12500,
        owes_now_cents:0, receipt_needs_review:false, responsibility_source:'not_final'}});
    return billing;
  }
  const insured = scenario === 'insured';
  const paid = scenario === 'paid';
  const draft = ['unposted', 'unsigned-codes'].includes(scenario);
  const account = ['paid', 'unposted', 'insured', 'unsigned-codes'].includes(scenario) ? {id: accountId, patient_id: patient.id, status: draft ? 'draft' : 'posted',
    version: correction ? 2 : 1, total_cents: chargeCents, service_date: date, has_visit: true,
    content: {visit_id: currentVisit.id, service_date: date, currency: 'USD',
      coverage_id: insured ? coverageId : null, lines: [correction || procedure]}} : null;
  const coverage = {id: coverageId, status: 'active', version: 1, content: {payer_id: 'synthetic',
    plan_name: 'Synthetic PPO', priority: 'primary', member_id: 'SYN123', copay_cents: 0}};
  const claim = {id: claimId, status: 'draft', payer_name: 'Synthetic PPO', frequency: 'original', automatic: true, issues: []};
  const facts = {patient_id: patient.id, visit: currentVisit, account, balance_cents: paid ? 0 : account ? chargeCents : null,
    charges_cents: account ? chargeCents : null, receipts: paid ? [receipt] : [],
    patient: {responsibility_cents: insured ? 0 : chargeCents, owes_now_cents: 0, received_cents: paid ? chargeCents : 0,
      receipts_applied_cents: paid ? chargeCents : 0, copay_cents: insured ? 0 : null,
      copay_paid_cents: insured ? 0 : null, copay_due_cents: insured ? 0 : null}};
  return {
    accounts: account ? [account] : [], coverages: insured ? [coverage] : [], copays: facts.receipts,
    claims: insured ? [claim] : [], entries: [],
    diagnoses: account ? [diagnosis] : currentVisit.diagnoses || [],
    summary: insured ? visitSummary({...facts, state: 'send_claim', claim,
      insurance: {coverage_id: coverageId, insurer: 'Synthetic PPO', pending_cents: chargeCents}})
      : selfPay({...facts, state: paid ? 'paid_in_full' : draft ? 'post_charges' : 'add_charges'})
  };
}

function fixture(route, currentVisit, scenario, correction, currentRooming) {
  const billing = encounterBilling(currentVisit, scenario, correction);
  switch (route) {
    case '/auth/me': return staff;
    case '/auth/mode': return {mode: 'local'};
    case '/api/v1/connect/status': return {status: 'not_connected', services: {configured: false}, transport: {configured: false}};
    case '/api/v1/billing/payers': return ['draft-insured','handoff'].includes(scenario)?list([{id:'synthetic', content:{name:'Synthetic PPO',payer_code:'SYN'}}]):list([]);
    case '/api/v1/patients': return list([patient]);
    case patientPath: return patient;
    case patientPath + '/workspace': return {patient, visits: [currentVisit], appointments: [appointment], amendments: [], flags: []};
    case patientPath + '/banner': return {patient_id: patient.id, revision: 'synthetic', billing: {patient_due_cents: 0}, eligibility: [], flags: {}};
    case patientPath + '/demographics': return {content: {}};
    case patientPath + '/intake-packets': return {patient_id: patient.id, summary: {}, ...list([])};
    case patientPath + '/billing': return {patient, ...billing};
    case patientPath + '/billing/visit-summary': return billing.summary;
    case '/api/v1/billing/copay-receipts/' + receipt.id: return {receipt, context: {patient, appointment}};
    case patientPath + '/visits/' + visit.id + '/checkout': return {visit: currentVisit, version: 1, events: [], releases: [],
      checkout: {completed: false}, readiness: {issues: []}, current_avs: null, preview_snapshot: {},
      preview_digest: 'synthetic-preview', followups: []};
    case visitPath: return currentVisit;
    case visitPath + '/note-authorship': return {assigned: {id: staff.user_id, name: staff.display_name}, amendments: []};
    case visitPath + '/diagnoses': return {visit: currentVisit, diagnoses: billing.diagnoses, history: [],
      can_edit: true, version: currentVisit.version};
    case visitPath + '/previous-note': return {source: null};
    case roomingPath: return {visit: currentVisit, version: currentVisit.version, history: [],
      can_edit: currentVisit.status !== 'signed', ...currentRooming};
    default: return {...list([]), appointments: [], blocks: [], providers: [], events: [], forms: [], history: [], orders: [],
      markers: [], results: [], reviews: [], reports: [], acknowledgments: [], specimens: [], entries: [], variants: [], options: []};
  }
}

function startTrace(sectionSelector) {
  const frame = document.querySelector('#chart').closest('.frame-content') || document.querySelector('#app > main');
  const top = selector => document.querySelector(selector)?.getBoundingClientRect().bottom || 0;
  const section = document.querySelector(sectionSelector);
  const heading = section.querySelector('[data-encounter-label], [data-encounter-section-heading]') || section;
  function geometry() {
    const bounds = heading.getBoundingClientRect();
    return {position: Math.round(frame.scrollTop),
      heading: Math.round(bounds.top), headingBottom: Math.round(bounds.bottom),
      stickyBottom: Math.ceil(Math.max(top('.shell-topbar'), top('#patient-banner'), top('#encounter-stepper'), top('#encounter-stepper .encounter-step-toolbar'))),
      viewportBottom: Math.floor(frame.getBoundingClientRect().bottom),
      focusInSection: section.contains(document.activeElement),
      focusedStep: document.activeElement.getAttribute('data-encounter-step-open'),
      viewedStep: document.querySelector('#encounter-stepper [data-step-viewed="true"]')?.dataset.encounterStepOpen,
      pageScrolled: window.scrollY};
  }
  const start = geometry();
  const samples = [start.position];
  const begun = performance.now();
  let lastMove = begun;
  const trace = window.encounterScrollTrace = {
    finished: false,
    result: () => ({samples, start, end: geometry()})
  };
  function next(now) {
    const position = Math.round(frame.scrollTop);
    if (samples.at(-1) !== position) lastMove = now;
    samples.push(position);
    // Chromium can take over half a second on a long scroll even on a high-refresh display.
    trace.finished = now - begun > 850 && now - lastMove > 120;
    if (!trace.finished) requestAnimationFrame(next);
  }
  requestAnimationFrame(next);
}

async function encounterSections(page) {
  return page.$$eval('#encounter-stepper [data-encounter-step-open]:not([hidden])', chips => chips.map(chip => {
    const key = chip.dataset.encounterStepOpen;
    const label = chip.querySelector('span').textContent.replace(/^✓\s*/, '');
    const section = chip.hasAttribute('aria-controls') ? '#' + chip.getAttribute('aria-controls')
      : '[data-encounter-step-number="' + key + '"]';
    return {chip: '#encounter-stepper [data-encounter-step-open="' + key + '"]', key, label, section};
  }));
}

async function checkCompactVisit(page, note, screenshotPrefix) {
  await page.waitForSelector('#encounter-rooming-vitals [data-encounter-label]', {visible:true});
  assert.equal(await page.$('[data-signed-intake], #encounter-benefits'), null);
  const signedNote = note.section + ' #signed-note-record';
  const launcher = note.section + ' [data-open-encounter-codes]';
  const codeSummary = note.section + ' [data-encounter-codes-summary]';
  await page.waitForSelector(launcher, {visible: true});
  await page.waitForSelector(codeSummary, {visible: true});
  assert.match(await page.$eval(signedNote, note => note.innerText), /Synthetic complaint/);
  assert.equal(await page.$(codesDialog), null, 'Posted coding editor opens only on request');
  const summary = await page.$eval(codeSummary, section => section.innerText);
  assert.match(summary, /\bJ30\.9\b/);
  assert.match(summary, /\b99213\b/);
  assert.match(summary, /\$180\.00/);
  assert.doesNotMatch(await page.$eval(note.section, section => section.innerText), /Add procedure|Save changes/);
  if (screenshotPrefix) {
    await page.waitForSelector('#visit-page-host [data-payment-summary]', {visible: true});
    await page.waitForSelector('[data-open-visit-followup]', {visible: true});
    await page.screenshot({path: screenshotPrefix + '-encounter.png'});
  }

  await page.locator(note.section + ' [data-action="focus-amendment"]').click();
  await page.waitForSelector('dialog[open] #amendment-form textarea[name=text]', {visible: true});
  await page.locator('dialog[open]:has(#amendment-form) [data-sheet-close]').click();
  await page.waitForSelector('dialog[open] #amendment-form', {hidden: true});

}

async function checkOptionalFollowup(page, note, payment) {
  const panel='dialog[data-visit-followup-dialog]';
  const launcher=note.section+' [data-open-visit-followup]';
  await page.waitForSelector(launcher,{visible:true});
  assert.equal(await page.$eval(panel,p=>p.open),false);
  const book='#patient-banner [data-chart-book]';
  await page.waitForSelector(book,{visible:true});
  await page.click(book);
  await page.waitForSelector('dialog[open] #schedule-booking',{visible:true});
  assert.equal(await page.$eval('#schedule-booking',f=>f.dataset.chartPatient),patient.id);
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open] #schedule-booking',{hidden:true});
  await page.locator(launcher).click();
  const instructions=panel+'[open] #avs-release-form textarea[name=instructions]';
  await page.waitForSelector(instructions,{visible:true});
  await page.locator(instructions).fill(instructionsDraft);
  await page.keyboard.press('Escape');
  await page.click(payment.chip);
  await page.evaluate(()=>setEncounterSection('checkout'));
  await page.waitForSelector(instructions,{visible:true});
  await page.evaluate(()=>loadVisitCheckout());
  assert.equal(await page.$eval(instructions,f=>f.value),instructionsDraft);
  await page.locator(panel+' [data-checkout-tab="followups"]').click();
  await page.waitForSelector(panel+' [data-checkout-pane="followups"]:not([hidden])',{visible:true});
  await page.keyboard.press('Escape');
  await page.waitForSelector(panel+'[open]',{hidden:true});
}

async function checkInlineRooming(page, signed, releaseSave, screenshotPrefix) {
  const rooming = '#encounter-rooming-vitals';
  const form = rooming + ' #rooming-form';
  const chief = form + ' [name=chief_complaint]';
  const checklist = rooming + ' [data-rooming-checklist-state]';
  if (signed) {
    const warnings = '#visit-page-host [data-signed-intake-warnings]';
    await page.waitForFunction(selector => /Chief complaint not recorded/i.test(document.querySelector(selector)?.innerText || ''), {}, warnings);
    assert.doesNotMatch(await page.$eval(warnings, node => node.innerText), /Medication review not recorded|Allergy review not recorded|Vitals not recorded/i);
    assert.equal(await page.$eval(rooming, node => node.querySelectorAll('textarea:not([readonly]), input:not([readonly]):not([disabled]), select:not([disabled])').length), 0,
      'A signed encounter shows the specific missing rooming item without an editable form');
    return;
  }

  await page.waitForSelector(checklist + '[data-rooming-checklist-state="missing"]');
  const chiefField = await page.waitForSelector(chief, {visible: true});
  assert.equal(await chiefField.evaluate(field => field.closest('[data-rooming-needed]') !== null), true);
  assert.match(await chiefField.evaluate(field => field.labels[0].innerText), /Reason for visit/);
  assert.ok(await chiefField.evaluate(field => field.getBoundingClientRect().height < 46), 'Blank complaint occupies a single text row');
  assert.ok(await chiefField.evaluate(field => {
    const original = field.value, short = field.getBoundingClientRect().height;
    field.value = 'Line one\nLine two\nLine three\nLine four';
    const long = field.getBoundingClientRect().height;
    field.value = original;
    return long > short;
  }), 'A longer complaint expands without changing its contents');
  assert.equal(await chiefField.evaluate(field => document.getElementById(field.getAttribute('aria-describedby'))?.innerText), 'Needed');
  assert.equal(await page.$$eval(rooming + ' [data-rooming-needed]', items => items.length), 1,
    'Only the missing chief complaint is highlighted, with no extra vitals requirement');
  assert.equal(await page.$$eval('#visit-page-host #rooming-form', forms => forms.length), 1);
  assert.doesNotMatch(await page.$eval(rooming, node => node.innerText), /Rooming not finished: add the chief complaint/i);

  const review = rooming + ' dialog[data-rooming-review]';
  const detailsButton = form + ' [data-rooming-open-details]';
  await page.waitForSelector(detailsButton, {visible: true});
  assert.equal(await page.$eval(review, details => details.open), false);
  if (screenshotPrefix) {
    await page.waitForFunction(() => !document.querySelector('.shell-topbar')?.innerText.includes('Checking connection'));
    await chiefField.evaluate(field => field.scrollIntoView({block: 'center', behavior: 'instant'}));
    await page.screenshot({path: screenshotPrefix + '-rooming.png'});
  }
  await page.locator(detailsButton).click();
  await page.waitForSelector(review + '[open]',{visible:true});
  for (const check of ['medications_reviewed', 'allergies_reviewed']) {
    const control = await page.waitForSelector(form + ' [name=' + check + ']', {visible: true});
    assert.equal(await control.evaluate(input => input.checked), true, 'Saved review checks remain accessible');
  }
  // Correct a previously checked review and finish it with the keyboard.
  const allergy = form + ' [name=allergies_reviewed]';
  await page.focus(allergy);
  await page.keyboard.press('Space');
  assert.equal(await page.$eval(allergy, field => field === document.activeElement && field.closest('[data-rooming-needed]') !== null), true);
  await page.keyboard.press('Space');
  assert.equal(await page.$eval(allergy, field => field.checked && !!field.closest('[data-rooming-completed-fields]')), true);
  assert.equal(await page.$eval(allergy, field => field.checked && field === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector(review+'[open]',{hidden:true});
  assert.equal(await page.$eval(detailsButton,button=>button===document.activeElement),true);
  const vitals = rooming + ' details[data-rooming-vitals-review]';
  assert.equal(await page.$eval(vitals, details => details.open), false);
  await page.locator(vitals + ' > summary').click();
  const vitalsForm = vitals + '[open] #vitals-form';
  await page.waitForSelector(vitalsForm, {visible: true});
  const systolic = vitalsForm + ' [name=systolic_mm_hg]';
  const diastolic = vitalsForm + ' [name=diastolic_mm_hg]';
  assert.equal(await page.$$eval(vitalsForm + ' [aria-invalid=true]', fields => fields.length), 0,
    'Blank optional vitals have no missing-field marks');
  await page.locator(systolic).fill('120');
  await page.waitForSelector(diastolic + '[aria-invalid=true]', {visible: true});
  await page.waitForSelector(vitalsForm + ' [data-vital-issue=diastolic_mm_hg]:not([hidden])', {visible: true});
  assert.equal(await page.$eval(systolic, field => field.getAttribute('aria-invalid')), null);
  await page.locator(systolic).fill('');
  await page.waitForSelector(diastolic + '[aria-invalid=true]', {hidden: true});
  await page.waitForSelector(vitalsForm + ' [data-vital-issue=diastolic_mm_hg]:not([hidden])', {hidden: true});
  await page.locator(vitals + ' > summary').click();

  await page.focus(chief);
  await page.keyboard.type(roomingComplaint, {delay: 25});
  assert.deepEqual(await chiefField.evaluate(field => ({focused: field === document.activeElement, value: field.value})),
    {focused: true, value: roomingComplaint},
    'The highlighted field retains keyboard focus through each edit');
  await page.waitForSelector(checklist + '[data-rooming-checklist-state="saving"]', {visible: true});
  assert.equal(await chiefField.evaluate(field => field === document.activeElement), true, 'The pending save preserves focus');
  releaseSave();
  assert.equal(await page.$eval(form+' [name=status]',field=>field.value),'ready');
  await page.waitForSelector(checklist + '[data-rooming-checklist-state="complete"]', {visible: true});
  assert.equal(await page.$$eval('#visit-page-host #rooming-form', forms => forms.length), 1);
  assert.equal(await page.$$eval(rooming + ' [data-rooming-needed]', fields => fields.length), 0);
  assert.equal(await page.$eval(chief, field => field.value), roomingComplaint);
  console.log('Only the missing chief complaint is highlighted. The field retains keyboard focus, and the final field and completed reviews save together as ready.');
}

async function checkBillingSections(page, scenario, refreshBilling, screenshotPrefix) {
  const sections = await encounterSections(page);
  const note = sections.find(section => ['Visit', 'Note'].includes(section.label));
  const coding = sections.find(section => section.label === 'Coding') || note;
  const payment = sections.find(section => section.label === 'Payment');
  assert.ok(note && coding && payment);
  assert.ok(!sections.some(section=>section.label==='Wrap-up'), 'Follow-up is optional inside Visit');
  assert.ok(sections.every(section => !['Charges', 'Claim'].includes(section.label)), 'Self-pay has no standalone Charges or Claim chip');
  assert.equal(await page.$$eval('[data-step-claim],#encounter-step-claim', elements =>
    elements.filter(element => element.checkVisibility()).length), 0, 'Self-pay has no visible standalone Charges or Claim section');

  const compact = coding === note;
  if (compact && scenario === 'paid') await checkCompactVisit(page, note, screenshotPrefix);
  if (screenshotPrefix) await page.evaluate(startTrace, payment.section);
  await page.click(payment.chip);
  const paymentDetails = payment.section + ' dialog[data-step-payment-details]';
  const paymentHistory=payment.section+' [data-open-encounter-payment-history]';
  if (compact) {
    const paidSummary = payment.section + ' [data-step-payment] [data-payment-summary]';
    await page.waitForSelector(paidSummary, {visible: true});
    const summary = await page.$eval(paidSummary, node => node.innerText.replace(/\s+/g, ' '));
    assert.match(summary, scenario === 'paid' ? /No patient amount due/ : /Balance available after charges are posted/i);
    assert.equal(await page.$eval(paymentDetails, details => details.open), false, 'Detailed payment tools remain folded');
  } else {
    const paymentTotals = payment.section + ' .visit-billing-totals';
    await page.waitForSelector(paymentTotals, {visible: true});
    const totals = await page.$$eval(paymentTotals + ' > span', boxes => Object.fromEntries(boxes.map(box =>
      [box.querySelector('small')?.innerText, box.querySelector('b')?.innerText])));
    assert.equal(totals.Charges, '$180.00');
    assert.equal(totals['Patient paid'], scenario === 'paid' ? '$180.00' : '$0.00');
    assert.equal(scenario === 'paid' ? totals['Patient owes now'] : totals['Patient will owe'], scenario === 'paid' ? '$0.00' : '$180.00');
  }
  const paymentContent = await page.$eval(payment.section, element => element.innerText);
  assert.doesNotMatch(paymentContent, /\b(?:Edit|Add) codes\b|\bProcedures \(CPT\)|\b99213\b|\bJ30\.9\b/, 'Payment has monetary totals without an extra coding view or editor');
  if (compact) assert.doesNotMatch(paymentContent, /Write-off or adjustment|Change to balance/i, 'Detailed payment controls stay out of the default view');

  if (scenario === 'paid') {
    const receiptButton = payment.section + (compact ? ' [data-step-payment]' : ' [data-step-receipts]') + ' [data-copay-receipt]';
    const receiptControl = await page.waitForSelector(receiptButton, {visible: true});
    if (compact) assert.match(await receiptControl.evaluate(button => button.innerText), /View receipt/i);
    if (screenshotPrefix) {
      await page.waitForFunction(() => window.encounterScrollTrace.finished);
      await page.waitForFunction(chip => document.querySelector(chip)?.dataset.stepViewed === 'true', {}, payment.chip);
      await page.screenshot({path: screenshotPrefix + '-payment.png'});
    }
    await page.click(receiptButton);
    await page.waitForSelector('dialog[open] .receipt-preview-frame', {visible: true});
    await page.waitForSelector('dialog[open] [data-receipt-preview-print]', {visible: true});
    await page.waitForFunction(() => document.querySelector('dialog[open] .receipt-preview-frame')?.contentDocument?.body?.innerText.includes('$180.00'));
    if (screenshotPrefix && compact) {
      await page.$eval('dialog[open]', dialog => Promise.allSettled(dialog.getAnimations().map(animation => animation.finished)));
      await page.screenshot({path: screenshotPrefix + '-receipt.png'});
    }
    await page.click('dialog[open] .receipt-preview [data-sheet-close]');
    await page.waitForSelector('dialog[open] .receipt-preview-frame', {hidden: true});
    if (compact) {
      await page.locator(paymentHistory).click();
      await page.waitForSelector(paymentDetails + '[open] #visit-billing-payments', {visible: true});
      await page.waitForSelector(paymentDetails + '[open] #visit-billing-invoices', {visible: true});
      await page.waitForSelector(paymentDetails + '[open] [data-new-ledger]', {visible: true});
      await page.keyboard.press('Escape');
      await checkOptionalFollowup(page, note, payment);
    }
  }

  await page.evaluate(startTrace,coding.section);
  await page.click(coding.chip);
  await page.waitForFunction(()=>window.encounterScrollTrace.finished);
  const launcher = coding.section + ' [data-open-encounter-codes]';
  await page.locator(launcher).click();
  const editor = codesDialog + ' #encounter-billing-editor';
  await page.waitForSelector(editor, {visible: true});
  const readout = await page.$eval(codesDialog, node => [node.innerText, ...Array.from(
    node.querySelectorAll('input[name=code],input[name=procedure]'), field => field.value
  )].join('\n'));
  assert.match(readout, /\b99213\b/, 'CPT remains in the encounter coding source');
  assert.match(readout, /\bJ30\.9\b/, 'The ICD-10 diagnosis remains in the encounter coding source');
  if (scenario === 'unposted') {
    const enabled = await page.$$eval(codesDialog + ' [data-visit-post-charges]', buttons =>
      buttons.filter(button => button.checkVisibility() && !button.disabled).length);
    assert.equal(enabled, 1, 'A signed, unposted self-pay encounter can post its charges');
    await page.keyboard.press('Escape');
    return;
  }

  const correctCharges = editor + ' [data-edit-charges]';
  if (await page.$(correctCharges)) await page.click(correctCharges);
  const correctionForm = editor + ' #billing-account-form[data-mode=correction]';
  const procedureUnits = correctionForm + ' [name=units]:not([readonly]):not([disabled])';
  await page.waitForSelector(procedureUnits, {visible: true});
  await page.waitForSelector(codesDialog + ' [data-diagnosis-add]:not([disabled])', {visible: true});
  assert.doesNotMatch(await page.$eval(correctionForm, form => form.innerText),
    /Until the insurer answers|No copay recorded for this plan/i, 'Known self-pay coding has no insurer or plan-copay guidance');
  if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-coding.png'});
  const procedureRows = correctionForm + ' .billing-charge-row:not([data-charge-removed])';
  const addProcedure = await page.waitForSelector(correctionForm + ' [data-add-charge]', {visible: true});
  assert.equal(await addProcedure.evaluate(button => button.innerText), '+ Add procedure');
  await addProcedure.click();
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, {}, procedureRows);
  const [, unsavedProcedure] = await page.$$(procedureRows);
  await (await unsavedProcedure.$('[data-remove-charge]')).click();
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, {}, procedureRows);
  await page.locator(procedureUnits).fill('2');
  if (compact) {
    await page.locator(codesDialog + ' [data-close-encounter-codes]').click();
    await page.waitForSelector(codesDialog, {hidden: true});
    await page.click(payment.chip);
    await page.click(coding.chip);
    await page.locator(launcher).click();
    assert.equal(await page.$eval(procedureUnits, input => input.value), '2', 'A pending correction survives section navigation');
  }
  await page.locator(codesDialog + ' [data-save-encounter-codes]').click();
  await page.waitForSelector(codesDialog, {hidden: true});
  await page.waitForFunction(selector => document.querySelector(selector)?.innerText.includes('× 2'), {},
    coding.section + ' [data-encounter-codes-summary]');
  await refreshBilling('insured');
  const claimStatus=note.section+' [data-encounter-claim-status]';
  await page.waitForSelector(claimStatus+' [data-encounter-claim-summary]',{visible:true});
  assert.deepEqual((await encounterSections(page)).map(section=>section.label),['Visit','Payment']);
  await page.locator(claimStatus+' [data-open-signed-claim-details]').click();
  const claimDialog='dialog[data-signed-claim-details][open]';
  await page.waitForSelector(claimDialog,{visible:true});
  assert.equal(await page.$$eval('#visit-page-host #encounter-billing-editor', elements=>elements.length),1);
  if(screenshotPrefix)await page.screenshot({path:screenshotPrefix+'-claim.png'});
  await page.keyboard.press('Escape');
  await page.waitForSelector(claimDialog,{hidden:true});
  await refreshBilling('paid');
  await page.waitForSelector(claimStatus,{hidden:true});
  const select='#frame-chart-select';
  if(await page.$eval(select,node=>node.checkVisibility()))await page.select(select,'insurance');
  else {
    const group='.frame-chart-navigation [data-chart-sidebar-group="Billing"]';
    const rail=await page.$eval('#frame-chart-navigation',nav=>nav.dataset.sidebarCollapsed==='true');
    const toggle=group+' [data-chart-group-toggle]';
    if(rail||await page.$eval(toggle,button=>button.getAttribute('aria-expanded')==='false'))await page.locator(toggle).click();
    const panel=rail?'[data-chart-group-flyout][open]':group;
    await page.locator(panel+' [data-chart-section="insurance"]').click();
  }
  await page.waitForSelector('[data-new-coverage]',{visible:true});
  await page.locator('[data-new-coverage]').click();
  const coverageForm = await page.waitForSelector('#coverage-form', {visible: true});
  assert.equal(await coverageForm.evaluate(form => form.dataset.patient), patient.id, 'Add insurance opens the current patient’s form');
  console.log('Signed self-pay keeps $180 paid, $0 owed and receipt preview. Posted CPT correction saves, Claim follows insurance status, and Add insurance opens the coverage form.');
  return compact;
}

async function checkFirstProcedureSave(page, releaseFirstSave, writes){
  const launcher='#encounter-documentation [data-open-encounter-codes]';
  const form=codesDialog+' #billing-account-form';
  const row=i=>form+' tr.billing-charge-row:nth-of-type('+i+')';
  const save=codesDialog+' [data-save-encounter-codes]';
  const firstSaveStarted=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname===patientPath+'/billing/accounts');
  async function fillLine(i,code,description,price){
    const input=row(i)+' [name=procedure]';
    await page.locator(input).fill(code+': '+description);
    await page.keyboard.press('Tab');
    await page.locator(row(i)+' [name=amount]').fill(price);
  }
  await page.locator(launcher).click();
  await fillLine(1,'99213','Synthetic office service','100.00');
  await firstSaveStarted;
  await page.locator(form+' [data-add-charge]').click();
  await fillLine(2,'97110','Synthetic exercise service','80.00');
  await page.locator(row(1)+' [name=amount]').fill('125.00');
  await page.locator(row(1)+' [data-modifier-toggle="25"]').click();
  await page.locator(save).click();
  await page.waitForFunction(selector=>document.querySelector(selector)?.disabled,{},save);
  releaseFirstSave();
  try{
    await page.waitForSelector(codesDialog,{hidden:true});
  }catch(cause){
    const report=await page.$eval(codesDialog,dialog=>({
      modal:dialog.querySelector('[data-codes-editor-state]')?.innerText,
      table:dialog.querySelector('[data-charge-status]')?.innerText,
      rows:[...dialog.querySelectorAll('.billing-charge-row')].map(row=>['code','modifiers','amount'].map(k=>row.querySelector('[name="'+k+'"]').value))
    }));
    throw new Error('Procedure editor remained open after the first account save: '+JSON.stringify({report,writes}),{cause});
  }
  const expected=[['99213','25',12500],['97110','',8000]];
  const signature=lines=>lines.map(line=>[line.code,line.modifiers||'',line.amount_cents]);
  assert.equal(writes.filter(w=>w.method==='POST').length,1,'The first visit draft creates exactly one account');
  assert.deepEqual(signature(writes.at(-1).lines),expected,'The latest edits to both rows reached the server');
  assert.deepEqual(writes.map(w=>w.method),['POST','PUT'],'One follow-up update saves both lines');
  async function reopenSavedTable(leaveBlank=false){
    await page.locator(launcher).click();
    const rows=form+' .billing-charge-row:not([data-charge-removed])';
    await page.waitForFunction(selector=>document.querySelectorAll(selector).length===2,{},rows);
    assert.deepEqual(await page.$$eval(rows,rows=>rows.map(row=>[
      row.querySelector('[name=code]').value,row.querySelector('[name=modifiers]').value,
      Math.round(parseFloat(row.querySelector('[name=amount]').value)*100)])),expected);
    if(leaveBlank){
      await page.locator(form+' [data-add-charge]').click();
      await page.waitForFunction(selector=>document.querySelectorAll(selector).length===3,{},rows);
    }
    await page.locator(save).click();
    await page.waitForSelector(codesDialog,{hidden:true});
    assert.equal(writes.length,2,'Closing a saved table with an optional blank row creates no further writes');
  }
  await reopenSavedTable(true);
  await page.reload({waitUntil:'load'});
  await reopenSavedTable();
  console.log('PASS first account autosave: two procedures, latest price and modifier survive Save and close and reload');
}

async function run(browser, viewport, reducedMotion, failures, scenario = 'blank') {
  const context = await browser.createBrowserContext();
  const errors = [];
  let currentVisit = structuredClone(visit);
  let correction = null, handoffs=0, savedHandoffAccount;
  if(scenario==='handoff')currentVisit.note={subjective:'Synthetic symptom',objective:'Synthetic exam',assessment:'Synthetic diagnosis',plan:'Synthetic follow-up'};
  if(scenario==='unsigned-codes')currentVisit.note={subjective:draftText,objective:'Synthetic exam',assessment:'Synthetic assessment'};
  const procedureWrites=[];
  let procedureAccount,releaseFirstProcedureSave;
  const firstProcedureSave=new Promise(resolve=>{releaseFirstProcedureSave=resolve;});
  if(scenario==='first-procedures')currentVisit.diagnoses=[diagnosis];
  const partialRooming = ['rooming', 'signed-rooming'].includes(scenario);
  let currentRooming = {status: partialRooming ? 'in_progress' : 'ready', chief_complaint: partialRooming ? '' : 'Allergy follow-up',
    intake_notes: '', medications_reviewed: true, allergies_reviewed: true};
  let releaseRoomingSave;
  const roomingSaveRelease = new Promise(resolve => { releaseRoomingSave = resolve; });
  if (!['blank', 'rooming', 'unsigned-codes', 'draft-insured', 'first-code', 'first-procedures', 'handoff'].includes(scenario)) {
    currentVisit.status = 'signed';
    currentVisit.signed_at = appointment.ends_at;
  }
  try {
    const page = await context.newPage();
    const requests = [];
    page.setDefaultTimeout(9000);
    await page.setViewport(viewport);
    await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference'}]);
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    async function respond(request) {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      const method = request.method();
      let data;
      if(scenario==='handoff'&&method==='POST'&&url.pathname===patientPath+'/billing/visits/'+visit.id+'/claim-handoff'){
        handoffs++;assert.equal(handoffs,1,'One explicit signature and delivery request');
        const body=JSON.parse(request.postData());
        assert.equal(body.sign_version,currentVisit.version);assert.equal(body.mode,'queue');assert.equal(body.account_id,accountId);assert.equal(body.account_version,savedHandoffAccount?.version||1);
        assert.equal(body.confirmations.routine_professional_reviewed,true);assert.equal(body.confirmations.synthetic_test_reviewed,false);
        currentVisit={...currentVisit,status:'signed',signed_by:staff.user_id,signed_at:date+'T17:30:00Z',version:currentVisit.version+1};
        data={...encounterBilling(currentVisit,'handoff').summary.claim_handoff,signed:true,visit_id:visit.id,account_id:accountId,visit_version:currentVisit.version};
      } else if(scenario==='handoff'&&method==='PUT'&&url.pathname===patientPath+'/billing/accounts/'+accountId){
        const saved=savedHandoffAccount||encounterBilling(currentVisit,'handoff').accounts[0];
        assert.equal(request.headers()['if-match'],'"'+saved.version+'"');
        const body=JSON.parse(request.postData());assert.equal(body.content.visit_id,currentVisit.id);assert.equal(body.content.lines[0].code,procedure.code);
        savedHandoffAccount={...saved,content:body.content,version:saved.version+1};
        data=savedHandoffAccount;
      } else if(scenario==='first-procedures'&&(
        (method==='POST'&&url.pathname===patientPath+'/billing/accounts')||
        (method==='PUT'&&url.pathname===patientPath+'/billing/accounts/'+accountId))){
        const body=JSON.parse(request.postData());
        assert.equal(body.content.visit_id,currentVisit.id);
        if(method==='POST'){
          assert.equal(procedureWrites.length,0,'No duplicated create request');
          assert.ok(body.request_id);
        }else{
          assert.ok(procedureAccount);
          assert.equal(request.headers()['if-match'],'"'+procedureAccount.version+'"');
        }
        procedureWrites.push({method,lines:body.content.lines});
        if(method==='POST')await firstProcedureSave;
        procedureAccount={id:accountId,patient_id:patient.id,has_visit:true,status:'draft',version:(procedureAccount?.version||0)+1,
          service_date:body.content.service_date,content:body.content,total_cents:body.content.lines.reduce((sum,line)=>sum+line.amount_cents,0)};
        data=procedureAccount;
      } else if (method === 'PUT' && url.pathname === visitPath + '/note') {
        const note = JSON.parse(request.postData());
        assert.equal(note.subjective, draftText, 'Only the synthetic note can autosave');
        currentVisit = {...currentVisit, note, version: currentVisit.version + 1};
        data = currentVisit;
      } else if (method === 'PUT' && scenario === 'first-code' && url.pathname === visitPath + '/diagnoses') {
        const body = JSON.parse(request.postData());
        assert.equal(body.diagnoses.length, 1);
        assert.equal(body.diagnoses[0].code, diagnosis.code);
        assert.equal(request.headers()['if-match'], '"1"');
        currentVisit = {...currentVisit, version: 2, diagnoses: body.diagnoses};
        data = fixture(url.pathname, currentVisit, scenario, correction, currentRooming);
      } else if (method === 'PUT' && url.pathname === roomingPath && scenario === 'rooming') {
        const pending = JSON.parse(request.postData());
        assert.equal(pending.chief_complaint, roomingComplaint);
        assert.equal(pending.medications_reviewed, true);
        assert.equal(pending.allergies_reviewed, true);
        assert.equal(request.headers()['if-match'], `"${currentVisit.version}"`);
        await roomingSaveRelease;
        currentRooming = pending;
        currentVisit = {...currentVisit, version: currentVisit.version + 1};
        data = fixture(url.pathname, currentVisit, scenario, correction, currentRooming);
      } else if (method === 'POST' && url.pathname === correctionPath && scenario === 'paid') {
        assert.equal(correction, null, 'Posted correction is sent once');
        assert.equal(request.headers()['if-match'], '"1"', 'Correction is scoped to the saved account version');
        const body = JSON.parse(request.postData());
        assert.equal(body.content.visit_id, currentVisit.id);
        assert.equal(body.content.lines.length, 1);
        const [line] = body.content.lines;
        assert.equal(line.code, procedure.code);
        assert.equal(line.units, 2);
        assert.equal(line.amount_cents, chargeCents);
        assert.equal(body.reason, 'Charge correction');
        assert.ok(body.request_id);
        correction = line;
        [data] = encounterBilling(currentVisit, scenario, correction).accounts;
      } else if (method !== 'GET') {
        errors.push('Unexpected write: ' + method + ' ' + url.pathname);
        return request.respond({status: 405, body: 'Synthetic fixture'});
      } else if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        requests.push(url.pathname);
        data = fixture(url.pathname, currentVisit, scenario, correction, currentRooming);
        if(scenario==='first-procedures'&&procedureAccount){
          if(url.pathname===patientPath+'/billing')data.accounts=[procedureAccount];
          if(url.pathname===patientPath+'/billing/visit-summary')Object.assign(data,{account:procedureAccount,charges_cents:procedureAccount.total_cents});
          if(url.pathname===patientPath+'/billing/accounts/'+accountId)data=procedureAccount;
        }
        if(scenario==='handoff'&&savedHandoffAccount){
          const account={...savedHandoffAccount,status:currentVisit.status==='signed'?'posted':'draft'};
          if(url.pathname===patientPath+'/billing')data.accounts=[account];
          if(url.pathname===patientPath+'/billing/visit-summary')data.account=account;
        }
      } else if (/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(url.pathname)) {
        return request.continue();
      } else {
        return request.abort();
      }
      return request.respond({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
    }
    page.on('request', request => void respond(request).catch(async error => {
      if (page.isClosed()) return;
      errors.push(error.message);
      if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
    }));
    await page.goto(origin + '/#/patients/' + patient.id + '/encounter/' + visit.id, {waitUntil: 'load'});
    try {
      await page.waitForSelector(currentVisit.status === 'signed' ? '#encounter-stepper .encounter-step-toolbar' : noteSelector, {visible: true});
      await page.waitForFunction(insured => encounterRevenueState.data?.summary?.insurance?.insured === insured, {}, ['draft-insured','handoff'].includes(scenario));
    } catch (cause) {
      const screen = await page.evaluate(() => ({hash: location.hash, title: document.querySelector('#page-title')?.textContent,
        notice: document.querySelector('#notice')?.textContent, noteExists: !!document.querySelector('#note-form'),
        chart: document.querySelector('#chart')?.innerText.slice(0, 1200), alerts: [...document.querySelectorAll('[role=alert]')].map(alert => alert.innerText)}));
      throw new Error('Synthetic encounter did not open: ' + JSON.stringify({screen, errors, requests}), {cause});
    }
    if(scenario==='handoff'){
      const action='#note-form [data-action="sign-bill"]:not([hidden])';
      await page.waitForFunction(selector=>document.querySelector(selector)?.innerText==='Sign & submit claim',{},action);
      const layout=await page.$eval('#encounter-documentation',section=>{
        const codes=section.querySelector('[data-encounter-codes-summary]');
        const note=section.querySelector('#note-form');
        const afterCodes=selector=>Boolean(codes.compareDocumentPosition(note.querySelector(selector))&Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          signAndSubmitAfterCodes:afterCodes('[data-action="sign-bill"]'),
          signOnlyAfterCodes:afterCodes('[data-action="sign"]'),
          saveBelongsToNote:note.querySelector('button[type="submit"]').form===note,
          claimOutsideNote:!note.contains(section.querySelector('[data-encounter-claim-status]'))
        };
      });
      assert.deepEqual(layout,{
        signAndSubmitAfterCodes:true,signOnlyAfterCodes:true,saveBelongsToNote:true,claimOutsideNote:true
      },'Review codes before signing while keeping the note and claim forms independent');
      assert.doesNotMatch(await page.$eval('[data-note-actions]',actions=>actions.innerText),/signing locks the note/i);
      await page.locator(action).click();
      await page.waitForSelector('[role=alertdialog]',{visible:true});
      const confirmation=await page.$eval('[role=alertdialog]',dialog=>dialog.innerText);
      assert.match(confirmation,/benefits are assigned/);
      assert.doesNotMatch(confirmation,/signing locks the note/i);
      await page.click('[role=alertdialog] button[data-dialog-cancel]');
      assert.equal(handoffs,0);
      await page.waitForFunction(selector=>!busy&&document.querySelector(selector)?.disabled===false&&
        !document.querySelector('[role=alertdialog]'),{},action);
      await page.locator(action).click();
      await page.locator('[role=alertdialog] button[data-dialog-confirm]').click();
      const status='[data-encounter-claim-status] [data-claim-handoff-status]';
      await page.waitForFunction(selector=>document.querySelector(selector)?.innerText.includes('Queued for Claim.MD'),{},status);
      assert.equal(handoffs,1);
      await page.reload({waitUntil:'load'});
      await page.waitForFunction(selector=>document.querySelector(selector)?.innerText.includes('Queued for Claim.MD'),{},status);
      assert.equal(await page.$('[data-visit-handoff-resume]'),null);
      assert.deepEqual(errors,[]);
      console.log('Insured visit: explicit signature queues one claim, cancellation does nothing, reload preserves unconfirmed delivery.');
      return;
    }
    if(scenario==='first-procedures'){
      await checkFirstProcedureSave(page,releaseFirstProcedureSave,procedureWrites);
      assert.deepEqual(errors,[]);
      return;
    }
    if (scenario === 'first-code') {
      const launcher = '#encounter-documentation [data-open-encounter-codes]';
      await page.waitForSelector(launcher, {visible:true});
      assert.equal(await page.$eval(launcher, button => button.innerText), 'Add diagnosis');
      await page.click(launcher);
      const dx = codesDialog + ' #visit-diagnoses-form';
      await page.waitForSelector(dx+' input[name=code]',{visible:true});
      assert.equal(await page.$$eval(dx+' input[name=code]',inputs=>inputs.length),1);
      await page.waitForFunction(form=>document.activeElement===document.querySelector(form+' input[name=code]'),{},dx);
      assert.equal(await page.$eval(dx+' input[name=code]',input=>input.getAttribute('aria-expanded')),'false','Autofocus starts with a quiet code field');
      await page.keyboard.press('Escape');
      await page.waitForSelector(codesDialog,{hidden:true});
      await page.locator(launcher).click();
      await page.waitForSelector(dx+' input[name=code]',{visible:true});
      await page.locator(dx + ' input[name=code]').fill(diagnosis.code);
      await page.locator(dx + ' input[name=display]').fill(diagnosis.display);
      const reasonField=await page.$(dx + ' [name=reason]');
      if(reasonField&&await reasonField.evaluate(field=>field.checkVisibility()))await reasonField.type('Synthetic visit diagnosis');
      await page.locator(codesDialog + ' [data-save-encounter-codes]').click();
      await page.waitForSelector(codesDialog, {hidden:true});
      assert.equal(currentVisit.diagnoses?.[0].code,diagnosis.code);
      const summary = '#encounter-documentation [data-encounter-codes-summary]';
      await page.waitForFunction(selector => document.querySelector(selector)?.innerText.includes('J30.9'), {}, summary);
      assert.equal(await page.$eval(launcher, button => button.innerText), 'Add procedure');
      assert.deepEqual(errors, []);
      console.log('Add diagnosis starts with the first ICD field and advances to Add procedure after saving.');
      return;
    }
    if (scenario === 'unsigned-codes') {
      const launcher = '#encounter-documentation [data-open-encounter-codes]';
      const summary = '#encounter-documentation [data-encounter-codes-summary]';
      await page.waitForSelector(launcher, {visible: true});
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('J30.9'), {}, summary);
      assert.equal(await page.$(codesDialog), null, 'Editing is closed initially');
      assert.match(await page.$eval(summary, node => node.innerText), /99213/);
      assert.match(await page.$eval(launcher, node => node.innerText), /Edit codes/);
      assert.equal(await page.$eval('#note-form', node => node.querySelectorAll('[data-note-inline], [data-note-code-search]').length), 0);
      assert.equal(await page.$eval('#note-form [data-note-autosave-retry]',button=>button.hidden),true);
      await page.locator('#note-form [data-action="sign"]').click();
      const plan='#note-form [name="plan"]';
      await page.waitForSelector(plan+'[aria-invalid="true"]',{visible:true});
      assert.deepEqual(await page.$$eval('#note-form [aria-invalid="true"]',fields=>fields.map(field=>field.name)),['plan']);
      assert.equal(await page.$eval('#note-plan-needed',hint=>hint.textContent),'Required to sign');
      await page.locator(plan).fill('Synthetic follow-up');
      await page.waitForFunction(()=>document.querySelector('#note-save-status')?.textContent==='Saved');
      assert.equal(currentVisit.note.plan,'Synthetic follow-up');
      assert.equal(await page.$(plan+'[aria-invalid="true"]'),null);
      const top = await page.$eval(launcher, button => {
        button.scrollIntoView({behavior:'instant', block:'center'});
        button.focus({preventScroll:true});
        return (button.closest('.frame-content') || document.querySelector('#app > main')).scrollTop;
      });
      await page.keyboard.press('Enter');
      await page.waitForSelector(codesDialog + ' #visit-diagnoses-form input[name="code"]', {visible: true});
      await page.waitForSelector(codesDialog + ' #billing-account-form input[name="amount"]', {visible: true});
      assert.equal(await page.$eval(codesDialog + ' #billing-account-form input[name="amount"]', node => node.value), '180.00');
      assert.equal(await page.$$eval('#billing-account-form', forms => forms.length), 1);
      await page.keyboard.press('Escape');
      await page.waitForSelector(codesDialog, {hidden: true});
      assert.deepEqual(await page.$eval(launcher, button => ({
        focused: document.activeElement === button, top: (button.closest('.frame-content') || document.querySelector('#app > main')).scrollTop
      })), {focused: true, top}, 'Closing the dialog restores focus and the original chart position');
      assert.equal(await page.$('#note-form .actions [data-menu], #note-form [data-note-diagnoses-editor]'), null);
      assert.equal(await page.$eval('#note-form [data-note-autosave-retry]',button=>button.hidden),true);
      assert.deepEqual(errors, []);
      console.log('Unsigned visit highlights only the missing Plan, saves it automatically, and preserves focus after closing the ICD/CPT editor.');
      return;
    }
    if (partialRooming) {
      try {
        await checkInlineRooming(page, currentVisit.status === 'signed', releaseRoomingSave, process.env.ENCOUNTER_TEST_SCREENSHOT_PREFIX);
      } catch (cause) {
        const screen = await page.evaluate(() => ({state: document.querySelector('[data-rooming-checklist-state]')?.dataset.roomingChecklistState,
          active: document.activeElement?.name, complaint: document.querySelector('#rooming-form [name=chief_complaint]')?.value,
          saveError: document.querySelector('[data-rooming-save-error]')?.textContent,
          noteMessage: document.querySelector('#note-message')?.innerText}));
        throw new Error('Synthetic rooming check failed: ' + JSON.stringify({scenario, screen, errors}), {cause});
      }
      assert.equal(currentVisit.version, scenario === 'rooming' ? 2 : 1, 'The final intake field and ready status are persisted in one write');
      if (scenario === 'rooming') assert.equal(currentRooming.status, 'ready');
      assert.deepEqual(errors, [], 'Browser errors and unexpected rooming writes');
      return;
    }
    if (scenario === 'draft-insured') {
      const claim='[data-encounter-claim-status]';
      const payment='dialog[data-step-payment-details]';
      await page.waitForSelector(claim+' [data-encounter-claim-summary]',{visible:true});
      const compact=await page.$eval('[data-step-payment]',node=>node.innerText);
      assert.doesNotMatch(compact,/test receipts|Correct receipt/);
      assert.deepEqual((await encounterSections(page)).map(section=>section.label),['Visit','Payment']);
      assert.match(await page.$eval(claim,node=>node.innerText),/Needs clinician signature/);
      assert.equal(await page.$(claim+' [data-open-signed-claim-details]'),null);
      await page.locator('#encounter-documentation [data-open-encounter-codes]').click();
      const ndcField=codesDialog+' .billing-charge-row [name="ndc_code"]';
      await page.waitForSelector(ndcField,{visible:true});
      assert.equal(await page.$eval(ndcField,field=>field.closest('.billing-charge-row').querySelector('[name="code"]').value),'J0585');
      const confirm='[role="alertdialog"] [data-dialog-confirm]';
      await page.evaluate(()=>{void confirmAction('Synthetic nested confirmation.').then(result=>{window.syntheticConfirmation=result;});});
      await page.waitForSelector(confirm,{visible:true});
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>window.syntheticConfirmation===false);
      await page.waitForSelector(codesDialog,{visible:true});
      await page.evaluate(()=>{void confirmAction('Synthetic nested confirmation.').then(result=>{window.syntheticConfirmation=result;});});
      await page.locator(confirm).click();
      await page.waitForFunction(()=>window.syntheticConfirmation===true);
      await page.waitForSelector(codesDialog,{visible:true});
      await page.keyboard.press('Escape');
      await page.locator('[data-step-payment] [data-open-encounter-payment-history]').click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-step-payment-details][open] #visit-billing-ledger [data-copay-receipt]').length===5);
      const records=await page.$$eval(payment+' .payment-row', rows=>rows.map(row=>({mode:row.innerText, id:row.querySelector('[data-copay-receipt]').dataset.copayReceipt,effect:row.querySelector('.money-cell').innerText})));
      assert.equal(new Set(records.map(row=>row.id)).size,5);
      assert(records.every(row=>row.mode.includes('Test payment')&&row.effect==='—'));
      assert.equal(await page.$$eval(payment+' [data-copay-receipt]', nodes=>nodes.length),5);
      assert.equal(await page.$(payment+' [data-copay-void]'),null);
      await page.evaluate(()=>loadEncounterRevenueStatus(encounterChargeAccount(), true));
      assert(await page.$eval(payment,node=>node.open));
      assert.deepEqual(errors, [], 'Coding and receipt details open without writes or browser errors');
      console.log('PASS unsigned insured browser visit: counts and test credit, five distinct receipts, coding details and payment history');
      return;
    }
    if (scenario !== 'blank') {
      const refreshBilling = async nextScenario => {
        scenario = nextScenario;
        // Run the same summary refresh as a background billing update, with the visit still mounted.
        await page.evaluate(() => loadEncounterRevenueStatus(encounterChargeAccount(), true));
      };
      let compact;
      try {
        compact = await checkBillingSections(page, scenario, refreshBilling, process.env.ENCOUNTER_TEST_SCREENSHOT_PREFIX);
      } catch (cause) {
        const screen = await page.evaluate(() => ({notice: document.querySelector('#notice')?.textContent,
          correction: document.querySelector('#billing-account-form')?.dataset.mode,
          version: document.querySelector('#billing-account-form')?.dataset.version,
          chargeStatus: document.querySelector('[data-charge-status]')?.innerText,
          codingStatus: document.querySelector('[data-encounter-coding-status]')?.innerText,
          instructionsOpen: document.querySelector('.avs-editor')?.open,
          instructionsRequested: document.querySelector('#avs-release-form [name=instructions]')?.getAttribute('aria-invalid'),
          focused: document.activeElement?.outerHTML.slice(0, 160),
          finishAction: document.querySelector('#encounter-stepper [data-step-finish]')?.outerHTML}));
        throw new Error('Synthetic billing check failed: ' + JSON.stringify({scenario, screen, errors}), {cause});
      }
      assert.deepEqual(errors, [], 'Browser errors and unexpected writes');
      return compact;
    }
    const sections = await encounterSections(page);
    const [note, payment] = ['Visit', 'Payment'].map(label =>
      sections.find(section => section.label === label || label === 'Visit' && section.label === 'Note'));
    const coding = sections.find(section => section.label === 'Coding');
    assert.ok(note && payment, 'Mounted encounter sections: ' + sections.map(section => section.label).join(', '));
    assert.ok(!sections.some(section => ['Charges', 'Claim'].includes(section.label)), 'Self-pay encounters omit a standalone Charges or Claim chip');
    const prefix = `${viewport.width}×${viewport.height}${reducedMotion ? ' reduced motion' : ''}`;
    function verify(condition, message) {
      if (!condition) failures.push(prefix + ' ' + message);
    }
    async function navigate(target, activate, {name = target.label, keyboard = false, measureMotion = true} = {}) {
      await page.evaluate(startTrace, target.section);
      await activate();
      await page.waitForFunction(() => window.encounterScrollTrace.finished);
      const {samples, start, end} = await page.evaluate(() => window.encounterScrollTrace.result());
      const low = Math.min(start.position, end.position);
      const high = Math.max(start.position, end.position);
      const between = new Set(samples.filter(position => position > low + 3 && position < high - 3));
      const evidence = `${start.position}→${end.position}px (${between.size} intermediate positions), heading ${end.heading}–${end.headingBottom}px, sticky controls end ${end.stickyBottom}px`;
      const focus = keyboard ? `, focus ${end.focusInSection ? 'in section' : end.focusedStep || 'lost'}` : '';
      console.log(`${prefix} ${name}  ${evidence}, viewed ${end.viewedStep || 'none'}${focus}`);
      const headingAlreadyVisible = start.heading >= start.stickyBottom && start.headingBottom <= start.viewportBottom;
      if (!headingAlreadyVisible) verify(high > low, name + ' should move the viewport, ' + evidence);
      if (measureMotion && high - low > 35) verify(reducedMotion ? between.size === 0 : between.size >= 2, name + ' has unexpected movement, ' + evidence);
      verify(end.heading >= end.stickyBottom - 1 && end.headingBottom <= end.viewportBottom,
        name + ' heading should land below sticky controls and within the viewport, ' + evidence);
      verify(end.viewedStep === target.key, name + ' should highlight ' + target.key + ', viewed ' + (end.viewedStep || 'none') + ', ' + evidence);
      verify(end.pageScrolled === 0, name + ' moved the outer window');
      if (keyboard) verify(end.focusInSection || end.focusedStep === target.key, name + ' lost keyboard focus');
    }
    if (coding) await navigate(coding, () => page.click(coding.chip));
    await navigate(payment, () => page.click(payment.chip));
    await navigate(note, () => page.click(note.chip));
    await page.$eval(noteSelector, (field, text) => {
      field.value = text;
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }, draftText);
    await page.focus(payment.chip);
    await navigate(payment, () => page.keyboard.press('Enter'), {name: 'keyboard Payment', keyboard: true});
    const billing = coding || payment;
    if (!reducedMotion) await navigate(billing, async () => {
      await page.click(note.chip);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await page.click(billing.chip);
    }, {name: 'rapid Visit → ' + billing.label});
    await navigate(note, async () => {
      const deltaY = await page.evaluate(() => {
        const {start} = window.encounterScrollTrace.result();
        return start.heading - start.stickyBottom - 22;
      });
      await page.mouse.move(viewport.width - 20, viewport.height * 0.55);
      await page.mouse.wheel({deltaY});
    }, {name: 'manual scroll to Visit', measureMotion: false});
    assert.equal(await page.$eval(noteSelector, field => field.value), draftText, 'Section navigation preserves typed draft text');
    assert.equal(currentVisit.note.subjective, draftText, 'Synthetic autosave completes during the navigation check');
    assert.deepEqual(errors, [], 'Browser errors and unexpected writes');
  } finally {
    releaseRoomingSave();
    releaseFirstProcedureSave();
    await context.close();
  }
}

module.exports={origin,id,staff,patient,appointment,visit,patientPath,fixture,list};
if(require.main===module)(async () => {
  const target = process.env.CHART_TEST_BROWSER ? {executablePath: process.env.CHART_TEST_BROWSER} : {channel: 'chrome'};
  const browser = await puppeteer.launch({...target, headless: true, pipe: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run']});
  const failures = [];
  try {
    const desktop = {width: 1280, height: 900};
    await run(browser, desktop, false, failures, 'handoff');
    await run(browser, desktop, false, failures, 'first-procedures');
    await run(browser, desktop, false, failures, 'first-code');
    await run(browser, desktop, false, failures, 'unsigned-codes');
    await run(browser, desktop, false, failures, 'draft-insured');
    const compact = await run(browser, {width: 1280, height: 1060}, false, failures, 'paid');
    await run(browser, desktop, false, failures, 'unposted');
    await run(browser, {width: 390, height: 844, isMobile: true, hasTouch: true}, false, failures, 'paid');
    if (compact) {
      await run(browser, desktop, false, failures, 'rooming');
      await run(browser, desktop, false, failures, 'signed-rooming');
    }
    await run(browser, desktop, false, failures);
    await run(browser, {width: 390, height: 844, isMobile: true, hasTouch: true}, false, failures);
    await run(browser, {width: 1280, height: 900}, true, failures);
    assert.deepEqual(failures, [], 'Encounter scroll regressions');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
