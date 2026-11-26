// SPDX-License-Identifier: AGPL-3.0-only
// INSURANCE_POS_TEST_URL=http://127.0.0.1:8095 node scripts/check_insurance_copay_pos_browser.cjs
'use strict';

const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

const origin = new URL(process.env.INSURANCE_POS_TEST_URL || 'http://127.0.0.1:8095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local preview');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id: id(111), tenant_id: id(112), role: 'owner', display_name: 'Synthetic staff', email: 'staff@example.invalid'};
const patient = {id: id(121), given_name: 'Avery', family_name: 'Example', mrn: 'SYN-121', birth_date: '1990-01-01', status: 'active'};
const appointment = {id: id(131), patient_id: patient.id, clinician_id: staff.user_id, status: 'checked_in',
  title: 'Synthetic office visit', starts_at: '2026-11-25T17:00:00Z', ends_at: '2026-11-25T17:30:00Z', timezone: 'America/Chicago'};
const otherAppointment = {...appointment, id: id(132), status: 'booked', title: 'Different synthetic visit',
  starts_at: '2026-12-02T17:00:00Z', ends_at: '2026-12-02T17:30:00Z'};
const payer = {id: id(141), content: {name: 'Synthetic Health', active: true}};
const amount = 2500;
const coverage = {id: id(142), patient_id: patient.id, version: 1, content: {payer_id: payer.id, plan_name: 'Synthetic plan',
  priority: 'primary', status: 'active', effective_date: '2026-01-01', copay_cents: amount, member_id: 'SYN-25',
  subscriber_name: 'Avery Example', subscriber_birth_date: patient.birth_date, relationship: 'self'}};
const reader = {id: id(151), name: 'Synthetic front desk reader', online: true, simulated: false};
const operationId = id(161);
const receiptId = id(162);
const patientPath = '/api/v1/patients/' + patient.id;
const appointmentCheckouts = id => `${patientPath}/appointments/${id}/copay-checkouts`;
const cardPath = appointmentCheckouts(appointment.id);
const deskPath = patientPath + '/billing/copays';
const receiptPath = '/api/v1/billing/copay-receipts/' + receiptId;
const list = items => ({items, total: items.length, next_cursor: null});
const chartRoute = '#/patients/' + patient.id + '/insurance';
const chart = '#insurance-workspace';
const launcher = '#insurance-page-copay [data-insurance-copay-collect="' + appointment.id + '"]';
const dialog = 'dialog.appointment-copay-pos.collect-sheet[open]';
const holder = dialog + ' [data-collect-holder]';

function fixture(path, {mode, operation, receipts}) {
  switch (path) {
    case '/auth/me': return mode === 'read-only' ? {...staff, role: 'read_only'} : staff;
    case '/auth/mode': return {mode: 'local'};
    case '/api/v1/connect/status': return {status: 'not_connected', services: {configured: false}, transport: {configured: false}};
    case '/api/v1/patients': return list([patient]);
    case patientPath: return patient;
    case patientPath + '/workspace': return {patient, visits: [], appointments: [appointment, otherAppointment], amendments: [], flags: []};
    case patientPath + '/demographics': return {content: {}};
    case patientPath + '/intake-packets': return {patient_id: patient.id, summary: {}, ...list([])};
    case patientPath + '/banner': return {patient_id: patient.id, revision: 'synthetic',
      billing: {patient_due_cents: mode === 'unknown-due' ? 0 : Math.max(0, amount - receipts.reduce((sum, receipt) => sum + receipt.amount_cents, 0))},
      eligibility: [], flags: {}};
    case patientPath + '/billing': return {patient, accounts: [], coverages: [mode === 'unknown-due'
      ? {...coverage, content: {...coverage.content, copay_cents: null}} : coverage], claims: [], entries: [], copays: receipts};
    case '/api/v1/billing/payers': return list([payer]);
    case cardPath: return {...list(operation ? [operation] : []), availability: {available: true, livemode: false}};
    case appointmentCheckouts(otherAppointment.id): return {...list([]), availability: {available: true, livemode: false}};
    case '/api/v1/billing/payments/readers': return {status: 'ready', payments_available: true, readers: [reader]};
    case '/api/v1/billing/patients/' + patient.id + '/payment-profile': return {patient_id: patient.id,
      payment_methods: {status: 'available', data: list([{setup_id: id(152), brand: 'visa', last4: '4242', charge_later: true}])}};
    case receiptPath: return {receipt: receipts.find(receipt => receipt.id === receiptId), context: {patient, appointment}};
    default: return {...list([]), appointments: [], blocks: [], providers: [], events: [], forms: [], history: [], orders: [],
      markers: [], results: [], reviews: [], reports: [], acknowledgments: [], specimens: [], entries: [], variants: [], options: []};
  }
}

async function confirmChart(page) {
  await page.waitForSelector(chart, {visible: true});
  assert.equal(new URL(page.url()).hash, chartRoute, 'The chart stays on Insurance & copay');
  assert.equal(await page.$eval('#patient-banner', element => element.dataset.patientId), patient.id);
  assert.equal(await page.$eval('#insurance-appointment', select => select.value), appointment.id);
}

async function closePos(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector(dialog, {hidden: true});
  await confirmChart(page);
}

async function openPos(page, keyboard = false, due = /\$25\.00/) {
  await page.waitForSelector('html.app-busy', {hidden: true});
  const control = await page.waitForSelector(launcher + ':not([disabled])', {visible: true});
  if (keyboard) {
    await control.focus();
    assert.equal(await control.evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
  } else {
    await control.click();
  }
  const modal = await page.waitForSelector(dialog, {visible: true});
  assert.equal(await modal.evaluate(node => node.matches(':modal') && node.contains(document.activeElement)), true);
  assert.equal(await page.$$eval('dialog:modal', modals => modals.length), 1);
  const context = await page.$eval(dialog + ' [data-appointment-pos-context]', element => element.innerText);
  assert.match(context, /Synthetic office visit/);
  assert.match(await page.$eval(dialog + ' [data-appointment-pos-amount]', element => element.innerText), due);
  return modal;
}

async function chooseMethod(page, method, formId, amount = '25.00') {
  const tab = await page.waitForSelector(dialog + ' [data-collect-method="' + method + '"]:not([disabled])', {visible: true});
  await tab.click();
  const form = await page.waitForSelector(holder + ' #' + formId, {visible: true});
  assert.deepEqual(await page.$$eval(dialog + ' [data-collect-method][aria-selected=true]', tabs => tabs.map(tab => tab.dataset.collectMethod)), [method]);
  assert.equal(await page.$$eval(holder + ' form', forms => forms.length), 1, 'Only the chosen payment form is mounted');
  assert.equal(await page.$$eval(dialog + ' input[name=amount]:not([disabled]):not([readonly])', fields => fields.length), 1,
    'Only the active method provides an editable amount');
  assert.equal(await page.$(dialog + ' [data-collect-target]'), null, 'The appointment copay has no separate amount input');
  assert.deepEqual(await form.evaluate(element => ({appointment: element.dataset.appointment, patient: element.dataset.patient})),
    {appointment: appointment.id, patient: patient.id});
  assert.equal(await form.$eval('[name=amount]', input => input.value), amount);
  return form;
}

async function run(browser, mode) {
  const context = await browser.createBrowserContext();
  const method = ['partial', 'duplicate', 'unknown-due'].includes(mode) ? 'cash' : mode;
  const expectedCents = mode === 'partial' ? 1000 : amount;
  const errors = [], requests = [], receipts = [], writes = [];
  let operation, confirmed = false, polls = 0;
  try {
    const page = await context.newPage();
    await page.setViewport({width: 1280, height: 900});
    page.setDefaultTimeout(12000);
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));

    function fakeReceipt(body) {
      const receipt = {id: receiptId, patient_id: patient.id, appointment_id: appointment.id, coverage_id: coverage.id,
        amount_cents: amount, allocated_cents: 0, occurred_on: '2026-11-25', voided: false, ...body};
      receipts.push(receipt);
      return receipt;
    }
    function readerOperation(body = {}) {
      return {id: operationId, patient_id: patient.id, appointment_id: appointment.id, channel: 'reader', reader_id: reader.id,
        coverage_id: coverage.id, payment_group_id: body.payment_group_id, request_id: body.request_id,
        status: 'open', livemode: false, amount_cents: amount, created_at: appointment.starts_at, receipt_id: null};
    }
    if (mode === 'read-only') fakeReceipt({method: 'cash'});
    async function respond(request) {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      const path = url.pathname;
      const verb = request.method();
      let data;
      if (verb === 'POST' && (path === deskPath || path === cardPath)) {
        assert.ok(!['duplicate', 'read-only', 'unknown-due'].includes(mode), 'This scenario must stay read-only');
        const body = JSON.parse(request.postData());
        assert.equal(writes.length, 0, 'A single activation creates one payment record');
        assert.equal(body.amount_cents, expectedCents);
        assert.equal(body.coverage_id, coverage.id);
        assert.ok(body.request_id);
        assert.ok(body.payment_group_id);
        if (path === deskPath) {
          assert.equal(body.appointment_id, appointment.id);
          assert.equal(body.method, method);
          assert.equal(body.received_confirmed, true);
          if (method === 'check') assert.equal(body.reference, 'SYN-CHECK-25');
          data = fakeReceipt({method, amount_cents: body.amount_cents, reference: body.reference, payment_group_id: body.payment_group_id});
        } else {
          assert.equal(method, 'reader');
          assert.equal(body.reader_id, reader.id);
          assert.equal(body.livemode, false);
          operation = readerOperation(body);
          data = {operation};
        }
        writes.push({path, body});
      } else if (verb !== 'GET') {
        errors.push('Unexpected write ' + verb + ' ' + path);
        return request.respond({status: 405, body: 'Synthetic fixture'});
      } else if (path === cardPath + '/' + operationId) {
        polls += 1;
        if (confirmed && operation?.status === 'open') {
          fakeReceipt({method: 'card', payment_group_id: operation.payment_group_id});
          operation = {...operation, status: 'paid', receipt_id: receiptId};
        }
        data = {operation};
      } else if (path.startsWith('/api/') || path.startsWith('/auth/')) {
        requests.push(path);
        data = fixture(path, {mode, operation, receipts});
      } else if (/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(path)) {
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

    try {
      await page.goto(origin + '/' + chartRoute, {waitUntil: 'load'});
      await page.waitForSelector('#insurance-appointment', {visible: true});
      await page.evaluate(() => {
        window.posLauncherEvents = [];
        for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
          const launcher = event.target.closest?.('[data-insurance-copay-collect]');
          if (launcher || event.key === 'Enter') window.posLauncherEvents.push({type, key: event.key,
            launcher: launcher?.dataset.insuranceCopayCollect, busy: document.documentElement.classList.contains('app-busy')});
        }, true);
      });
      if (mode === 'cash') {
        await page.select('#insurance-appointment', otherAppointment.id);
        await page.waitForSelector('#insurance-page-copay [data-insurance-copay-collect="' + otherAppointment.id + '"]', {visible: true});
      }
      await page.select('#insurance-appointment', appointment.id);
      const collect = await page.waitForSelector(launcher, {visible: true});
      assert.equal(await collect.evaluate(button => button.innerText), mode === 'read-only' ? 'View payments' : 'Collect copay');
      assert.equal(await page.$$eval(chart + ' [data-insurance-copay-collect]', buttons => buttons.filter(button => button.checkVisibility()).length), 1);
      assert.equal(await page.$$eval(chart + ' :is([data-collect-card-copay],[data-reader-copay],[data-saved-card-copay],[data-record-copay])',
        buttons => buttons.filter(button => button.checkVisibility() && !button.closest('details:not([open])')).length), 0);
      const status = chart + ' [data-insurance-copay-status]';
      const expectedStatus = mode === 'read-only' ? /\$25\.00 paid/i
        : mode === 'unknown-due' ? /No copay recorded/i : /\$25\.00.*due|due.*\$25\.00/i;
      assert.match(await page.$eval(status, element => element.innerText), expectedStatus);
      await confirmChart(page);
      await openPos(page, mode === 'cash', mode === 'read-only' ? /No copay due/i : mode === 'unknown-due' ? /Copay not recorded/i : /\$25\.00/);

      if (mode === 'read-only') {
        await page.waitForSelector(dialog + ' [data-copay-receipt="' + receiptId + '"]', {visible: true});
        assert.equal(await page.$$eval(dialog + ' [data-collect-method]', elements => elements.length), 0);
        await closePos(page);
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
        console.log('Read-only staff can see the recorded receipt and cannot start a payment.');
        return;
      }

      if (mode === 'cash') {
        await page.waitForSelector(dialog + ' [data-collect-method="cash"]:not([disabled])', {visible: true});
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval(dialog, element => element.contains(document.activeElement)), true);
        await closePos(page);
        await page.waitForFunction(selector => document.activeElement.matches(selector), {}, launcher);
        assert.equal(writes.length, 0);
        await openPos(page);
        for (const [tab, form] of [['check', 'collect-cash-form'], ['reader', 'reader-copay-form'], ['saved', 'saved-card-copay-form'],
          ['link', 'hosted-copay-form'], ['external', 'collect-cash-form']]) await chooseMethod(page, tab, form);
      }

      const form = await chooseMethod(page, method, method === 'reader' ? 'reader-copay-form' : 'collect-cash-form', mode === 'unknown-due' ? '' : '25.00');
      if (mode === 'unknown-due') {
        await (await form.$('button[type=submit]')).click();
        assert.equal(await form.evaluate(element => element.checkValidity()), false);
        assert.deepEqual(writes, []);
        await closePos(page);
        assert.deepEqual(errors, []);
        console.log('An unknown copay leaves the amount blank and requires staff to enter a value.');
        return;
      }
      if (method === 'check') await form.$eval('[name=reference]', input => { input.focus(); });
      if (method === 'check') await page.keyboard.type('SYN-CHECK-25');
      if (mode === 'partial') {
        await page.locator(holder + ' [name=amount]').fill('10.00');
        assert.equal(await form.$eval('[data-collect-submit]', button => button.innerText), 'Record $10.00 cash');
      }
      if (mode === 'duplicate') operation = readerOperation();
      if (mode === 'cash' && process.env.INSURANCE_POS_SCREENSHOT_PREFIX) {
        await page.mouse.move(20, 20);
        await page.$eval(dialog, node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
        await page.screenshot({path: process.env.INSURANCE_POS_SCREENSHOT_PREFIX + '-cash.png'});
      }
      assert.equal(writes.length, 0, 'Switching methods and inspecting amounts does not create a payment');
      await (await form.$('button[type=submit]')).click();

      if (mode === 'partial') {
        const progress = await page.waitForSelector(dialog + ' .collect-step-done', {visible: true});
        assert.match(await progress.evaluate(element => element.innerText), /\$10\.00.*\$15\.00 left to pay/s);
        assert.equal(writes.length, 1);
        assert.deepEqual(receipts.map(receipt => [receipt.appointment_id, receipt.amount_cents]), [[appointment.id, 1000]]);
        await closePos(page);
        await page.waitForFunction(selector => /\$15\.00.*due/i.test(document.querySelector(selector)?.innerText || ''), {}, status);
        await openPos(page, false, /\$15\.00 due/i);
        await chooseMethod(page, 'cash', 'collect-cash-form', '15.00');
        await closePos(page);
        assert.equal(writes.length, 1);
        assert.deepEqual(errors, []);
        console.log('A $10 partial receipt leaves $15 due on the selected appointment and pre-fills that remainder.');
        return;
      }

      if (mode === 'duplicate') {
        await page.waitForFunction(() => /Review the current payment status/i.test(document.querySelector('#notice')?.textContent || ''));
        assert.equal(await page.$eval(launcher, button => button.innerText), 'Review payment');
        assert.deepEqual(writes, []);
        assert.deepEqual(receipts, []);
        await closePos(page);
        assert.deepEqual(errors, []);
        console.log('A newly pending card operation blocks an attempted second tender before it sends a write.');
        return;
      }

      if (method === 'reader') {
        await page.waitForSelector(dialog + ' [data-reader-payment="waiting"]', {visible: true});
        await page.waitForFunction(() => document.querySelector('dialog[open] [data-reader-payment="waiting"]')?.innerText.includes('$25.00'));
        await page.waitForResponse(response => response.url() === origin + cardPath + '/' + operationId);
        assert.equal(polls > 0, true);
        assert.match(await page.$eval(chart + ' [data-insurance-copay-status]', element => element.innerText), /\$25\.00 payment pending/i);
        assert.equal(await page.$eval(launcher, button => button.innerText), 'Review payment');
        assert.equal(receipts.length, 0);
        assert.equal(await page.$(dialog + ' .collect-done'), null);
        assert.equal(await page.$(dialog + ' [data-collect-receipt]'), null);
        assert.equal(await page.$(dialog + ' [data-appointment-pos-activity] [data-watch-reader-copay="' + operationId + '"]'), null,
          'Active reader progress is shown in one place');
        if (process.env.INSURANCE_POS_SCREENSHOT_PREFIX) await page.screenshot({path: process.env.INSURANCE_POS_SCREENSHOT_PREFIX + '-reader-pending.png'});
        confirmed = true;
      }

      await page.waitForSelector(dialog + ' .collect-done', {visible: true});
      assert.match(await page.$eval(dialog + ' .collect-done', element => element.innerText), /\$25\.00.*recorded/i);
      assert.equal(writes.length, 1);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].appointment_id, appointment.id);
      assert.equal(receipts[0].patient_id, patient.id);
      await page.click(dialog + ' .collect-done [data-sheet-close]');
      await page.waitForSelector(dialog, {hidden: true});
      await confirmChart(page);
      await page.waitForFunction(selector => document.querySelector(selector)?.innerText === 'View payments', {}, launcher);
      assert.match(await page.$eval(chart + ' [data-insurance-copay-status]', element => element.innerText), /\$25\.00.*(?:paid|recorded)|(?:paid|recorded).*\$25\.00/i);
      assert.deepEqual(errors, [], 'Browser errors and unexpected writes');
      console.log(`${method} · one $25 synthetic receipt stayed with the original patient and appointment${method === 'reader' ? ' after server confirmation' : ''}.`);
    } catch (cause) {
      const screen = await page.evaluate(() => ({route: location.hash, notice: document.querySelector('#notice')?.innerText,
        content: document.querySelector('#insurance-workspace')?.innerText.slice(-650),
        dialog: document.querySelector('dialog[open]')?.innerText.slice(0, 650), launcherEvents: window.posLauncherEvents,
        focused: document.activeElement?.outerHTML.slice(0, 180)}));
      throw new Error('Synthetic insurance copay check failed ' + JSON.stringify({mode, screen, errors, requests: requests.slice(-12)}), {cause});
    }
  } finally {
    await context.close();
  }
}

(async () => {
  const target = process.env.CHART_TEST_BROWSER ? {executablePath: process.env.CHART_TEST_BROWSER} : {channel: 'chrome'};
  const browser = await puppeteer.launch({...target, headless: true, pipe: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run']});
  try {
    for (const mode of ['cash', 'check', 'reader', 'partial', 'duplicate', 'read-only', 'unknown-due']) await run(browser, mode);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
