// SPDX-License-Identifier: AGPL-3.0-only
// ENCOUNTER_TEST_URL=http://127.0.0.1:8095 node scripts/check_billing_editor_scope_browser.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const {selfPay} = require('./visit_billing_fixture.cjs');

const origin = new URL(process.env.ENCOUNTER_TEST_URL || 'http://127.0.0.1:8095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local preview');
const assetDir = process.env.BILLING_SCOPE_TEST_ASSETS;
const screenshotPrefix = process.env.BILLING_SCOPE_SCREENSHOT_PREFIX;
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id: id(1), tenant_id: id(2), role: 'owner', display_name: 'Synthetic clinician', email: 'staff@example.invalid'};
const patient = {id: id(3), given_name: 'Avery', family_name: 'Example', mrn: 'SYN-3', birth_date: '1990-01-01', status: 'active'};
const appointment = {id: id(4), patient_id: patient.id, clinician_id: staff.user_id, title: 'Synthetic office visit',
  starts_at: '2026-11-24T17:00:00Z', ends_at: '2026-11-24T17:30:00Z', status: 'completed'};
const first = {id: id(5), patient_id: patient.id, clinician_id: staff.user_id, appointment_id: appointment.id,
  encounter_number: 7, version: 1, status: 'in_progress', created_at: appointment.starts_at, note: {}, vitals: {}};
const second = {...first, id: id(6), encounter_number: 8, appointment_id: null};
const receipt = {id: id(7), patient_id: patient.id, appointment_id: appointment.id, amount_cents: 2500,
  allocated_cents: 0, method: 'cash', occurred_on: '2026-11-24', created_at: appointment.starts_at, voided: false};
const patientPath = '/api/v1/patients/' + patient.id;
const billingPath = '/api/v1/billing/patients/' + patient.id;
const list = (items = []) => ({items, total: items.length, next_cursor: null});
const draftAmount = '42.34';
const codeLauncher = '#encounter-documentation [data-open-encounter-codes]';
const codingDialog = 'dialog[data-encounter-codes-dialog][open]';
const procedureAmount = codingDialog + ' #encounter-billing-editor input[name="amount"]';
const switcher = '#patient-banner [data-encounter-switch]';
const chartBilling = '.frame-chart-navigation [data-chart-section="billing"]';
const hub = '#patient-billing-chart';
const assetTypes = {'.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};

function fixture(url) {
  const route = url.pathname;
  switch (route) {
    case '/auth/me': return staff;
    case '/auth/mode': return {mode: 'local'};
    case '/api/v1/connect/status': return {status: 'not_connected', services: {configured: false}, transport: {configured: false}};
    case '/api/v1/patients': return list([patient]);
    case patientPath: return patient;
    case patientPath + '/workspace': return {patient, visits: [first, second], appointments: [appointment], amendments: [], flags: []};
    case patientPath + '/banner': return {patient_id: patient.id, revision: 'synthetic', billing: {patient_due_cents: 0}, eligibility: [], flags: {}};
    case patientPath + '/demographics': return {content: {}};
    case patientPath + '/intake-packets': return {patient_id: patient.id, summary: {}, ...list()};
    case patientPath + '/billing': return {patient, accounts: [], coverages: [], copays: [receipt], claims: [], entries: []};
    case patientPath + '/billing/visit-summary':
      return selfPay({patient_id: patient.id, visit: url.searchParams.get('visit_id') === second.id ? second : first,
        account: null, state: 'add_charges', balance_cents: null, charges_cents: null,
        patient: {responsibility_cents: null, owes_now_cents: null}});
    case '/api/v1/billing/overview':
      return {patient, accounts: list(), copays: list([receipt]), summary: {accounts: {reviewed_patient_due_cents: 0},
        copays: {net_received_cents: 2500, usable_unapplied_cents: 2500, receipts: 1, review_count: 0}}};
    case billingPath + '/payment-history':
      return {patient_id: patient.id, mode: url.searchParams.get('mode'), ...list([{...receipt, receipt_id: receipt.id, kind: 'copay',
        status: 'recorded', received_cents: 2500, refunded_cents: 0, unapplied_cents: 2500}])};
    case billingPath + '/payment-profile':
      return {patient_id: patient.id, livemode: false, setup_available: true,
        payment_methods: {status: 'available', data: list()}, subscriptions: {status: 'available', data: list()}};
    case billingPath + '/memberships': return {patient_id: patient.id, livemode: false, ...list()};
    case billingPath + '/installment-plans':
      return {availability: {available: true, livemode: false}, ...list(),
        eligible_invoices: [{invoice_id: id(8), invoice_created_at: appointment.starts_at, remaining_cents: 8000, eligible: true}]};
    case '/api/v1/billing/copay-receipts/' + receipt.id: return {receipt, context: {patient, appointment}};
    default: {
      const visit = route.includes(second.id) ? second : first;
      if (route === '/api/v1/visits/' + visit.id) return visit;
      if (route.endsWith('/diagnoses')) return {visit, diagnoses: [], history: [], can_edit: true, version: visit.version};
      if (route.endsWith('/checkout')) return {visit, history: [], events: [], releases: [], readiness: {issues: []}, checkout: {completed: false}, followups: []};
      if (route.endsWith('/rooming')) return {visit, version: visit.version, history: [], can_edit: true, status: 'ready',
        chief_complaint: 'Synthetic follow-up', medications_reviewed: true, allergies_reviewed: true};
      return {...list(), appointments: [], blocks: [], providers: [], events: [], forms: [], history: [], orders: [],
        markers: [], results: [], reviews: [], reports: [], acknowledgments: [], specimens: [], entries: [], variants: [], options: []};
    }
  }
}

async function clickVisible(page, selector) {
  const button = await page.waitForSelector(selector, {visible: true});
  await page.waitForFunction(el => !el.disabled, {}, button);
  await button.click();
}

async function openChartBilling(page) {
  await clickVisible(page, '.frame-chart-navigation [data-chart-sidebar-group="Billing"] [data-chart-group-toggle]');
  await clickVisible(page, chartBilling);
}

async function waitForEncounter(page, visit) {
  await page.waitForSelector('[data-banner-encounter="' + visit.id + '"]');
  await page.waitForSelector('#note-form[data-visit-id="' + visit.id + '"]', {visible: true});
  await page.waitForFunction(route => location.hash === route, {}, '#/patients/' + patient.id + '/encounter/' + visit.id + '/visit');
}

async function noLeakedEditor(page) {
  const result = await page.evaluate(() => ({
    leaked: Boolean(document.querySelector('#billing-workspace #billing-account-form,#insurance-workspace #billing-account-form')),
    visible: [...document.querySelectorAll('#billing-account-form')].some(form => form.checkVisibility({contentVisibilityAuto: true}))
  }));
  assert.deepEqual(result, {leaked: false, visible: false}, 'The encounter procedure editor stays out of chart Billing');
}

async function run() {
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  const browser = await puppeteer.launch({headless: true, args, ...(process.env.CHROME_BINARY ?
    {executablePath: process.env.CHROME_BINARY} : {channel: 'chrome'})});
  const errors = [];
  let holdVisit, sawVisit;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    await page.setViewport({width: 1440, height: 1000});
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      async function respond() {
        const url = new URL(request.url());
        if (url.origin !== origin) return request.abort();
        if (request.method() !== 'GET') {
          errors.push('Unexpected write: ' + request.method() + ' ' + url.pathname);
          return request.respond({status: 405, body: 'Synthetic fixture'});
        }
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
          if (holdVisit && url.pathname === '/api/v1/visits/' + second.id) {
            sawVisit();
            await holdVisit;
          }
          return request.respond({contentType: 'application/json', body: JSON.stringify(fixture(url))});
        }
        const type = assetTypes[path.extname(url.pathname)];
        if (assetDir && type && /^\/[\w.-]+$/.test(url.pathname)) {
          const file = path.join(assetDir, path.basename(url.pathname));
          if (fs.existsSync(file)) return request.respond({contentType: type, body: fs.readFileSync(file)});
        }
        return request.continue();
      }
      void respond().catch(async error => {
        if (page.isClosed()) return;
        errors.push(error.message);
        if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
      });
    });

    await page.goto(origin + '/#/patients/' + patient.id + '/encounter/' + first.id, {waitUntil: 'load'});
    await page.waitForSelector(codeLauncher, {visible:true});
    assert.match(await page.$eval(codeLauncher, button => button.innerText), /Add codes/);
    await clickVisible(page, codeLauncher);
    await page.waitForSelector(procedureAmount, {visible: true});
    await page.waitForFunction(selector=>document.querySelector(selector)?.checkVisibility({contentVisibilityAuto:true}), {}, procedureAmount);
    await page.type(procedureAmount, draftAmount);
    assert.equal(await page.$eval(procedureAmount, field => field.value), draftAmount, 'The amount field accepted the edit before leaving the visit');
    await page.keyboard.press('Escape');
    await clickVisible(page, codingDialog + ' [data-retain-encounter-codes]');
    await page.waitForSelector(codingDialog, {hidden:true});
    await openChartBilling(page);
    await page.waitForSelector(hub + ' #patient-billing-tab-overview[aria-selected="true"]', {visible: true});
    await noLeakedEditor(page);

    await clickVisible(page, hub + ' #patient-billing-tab-subscriptions');
    await page.waitForSelector(hub + ' #patient-billing-memberships h3', {visible: true});
    await noLeakedEditor(page);

    // The switch keeps the first encounter current until the second visit finishes loading.
    let releaseVisit;
    holdVisit = new Promise(resolve => { releaseVisit = resolve; });
    const requested = new Promise(resolve => { sawVisit = resolve; });
    await clickVisible(page, switcher);
    await clickVisible(page, '[data-encounter-switch-pick="' + second.id + '"]');
    await clickVisible(page, '[data-encounter-switch-open]');
    await requested;
    await noLeakedEditor(page);
    assert.ok(await page.$('[data-banner-encounter="' + first.id + '"]'));
    releaseVisit();
    await waitForEncounter(page, second);
    await page.waitForSelector('dialog[open] [data-encounter-switch-open]', {hidden: true});

    await openChartBilling(page);
    await clickVisible(page, hub + ' #patient-billing-tab-subscriptions');
    await page.waitForSelector(hub + ' #patient-billing-memberships h3', {visible: true});
    await noLeakedEditor(page);
    if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-memberships.png'});
    await clickVisible(page, '[data-start-payment-plan-sheet]');
    await page.waitForSelector('dialog[open] #installment-preview-form', {visible: true});
    await noLeakedEditor(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open] #installment-preview-form', {hidden: true});

    await clickVisible(page, hub + ' #patient-billing-tab-methods');
    await page.waitForSelector(hub + ' #patient-billing-profile-section h3', {visible: true});
    await noLeakedEditor(page);
    if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-methods.png'});

    await clickVisible(page, hub + ' #patient-billing-tab-payments');
    await clickVisible(page, '[data-overview-receipt="' + receipt.id + '"]');
    const receiptDialog = await page.waitForSelector('dialog[open] .receipt-sheet', {visible: true});
    assert.match(await receiptDialog.evaluate(node => node.innerText), /\$25\.00/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open] .receipt-sheet', {hidden: true});
    await noLeakedEditor(page);

    await clickVisible(page, switcher);
    await clickVisible(page, '[data-encounter-switch-pick="' + first.id + '"]');
    await clickVisible(page, '[data-encounter-switch-open]');
    await waitForEncounter(page, first);
    await page.waitForSelector('dialog[open] [data-encounter-switch-open]', {hidden: true});
    await clickVisible(page, codeLauncher);
    await page.waitForSelector(procedureAmount, {visible: true});
    assert.equal(await page.$eval(procedureAmount, field => field.value), draftAmount, 'The unfinished procedure stays with the first visit');
    assert.equal(await page.$$eval('#billing-account-form', forms => forms.length), 1);
    if (screenshotPrefix) {
      await page.waitForFunction(visit => encounterRevenueState.visit === visit && encounterRevenueState.data?.summary?.insurance?.insured === false, {}, first.id);
      await page.waitForSelector('#encounter-stepper [data-encounter-step-open="claim"]', {hidden: true});
      await page.$eval(procedureAmount, field => field.scrollIntoView({block: 'center', behavior: 'instant'}));
      await page.screenshot({path: screenshotPrefix + '-return-encounter.png'});
    }
    assert.deepEqual(errors, []);
    console.log('PASS Chrome chart Billing, delayed encounter switch, membership and card management, $25 receipt, and return to the retained procedure draft');
  } catch (error) {
    const current = (await browser.pages()).at(-1);
    const state = await current.evaluate(() => ({
      url: location.hash, section: typeof chartSection !== 'undefined' ? chartSection : null,
      visible: document.querySelector('#visit-page-host')?.dataset.stepsVisible,
      editor: document.querySelector('#encounter-billing-editor')?.outerHTML.slice(0, 800),
      billingEditor: document.querySelector('#billing-editor')?.innerHTML.slice(0, 150),
      note: document.querySelector('#encounter-documentation')?.outerHTML.slice(0, 125),
      text: document.querySelector('#notice')?.innerText
    })).catch(() => ({}));
    throw new Error(JSON.stringify({state, errors}), {cause: error});
  } finally {
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
