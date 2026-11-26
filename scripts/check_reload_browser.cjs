// SPDX-License-Identifier: AGPL-3.0-only
// Run against the local preview: RELOAD_TEST_URL=http://127.0.0.1:8095 node scripts/check_reload_browser.cjs
'use strict';

const assert = require('node:assert/strict');
const {setTimeout: delay} = require('node:timers/promises');
const puppeteer = require('puppeteer-core');

const origin = new URL(process.env.RELOAD_TEST_URL || 'http://127.0.0.1:8095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local preview');
const patient = {
  id: '00000000-0000-4000-8000-000000000021',
  given_name: 'Avery', family_name: 'Example', mrn: 'SYN-21',
  birth_date: '1990-01-01', status: 'active'
};
const staff = {
  user_id: '00000000-0000-4000-8000-000000000011',
  tenant_id: '00000000-0000-4000-8000-000000000012',
  role: 'owner', display_name: 'Synthetic owner', email: 'staff@example.invalid'
};
const appointmentId = '00000000-0000-4000-8000-000000000031';
const personPath = '/api/v1/patients/' + patient.id;
const list = items => ({items, total: items.length, next_cursor: null});

function fixture(url) {
  switch (url.pathname) {
    case '/auth/me': return staff;
    case '/auth/mode': return {mode: 'local'};
    case '/api/v1/connect/status': return {status: 'not_connected', services: {configured: false}, transport: {configured: false}};
    case '/api/v1/practice/overview': return {money: {}, claims: {statuses: {}}};
    case '/api/v1/patients': return list([patient]);
    case '/api/v1/schedule/providers': return list([{id: staff.user_id, label: 'Synthetic clinician'}]);
    case '/api/v1/schedule': {
      const day = new Date().toISOString().slice(0, 10);
      const starts_at = day + 'T10:00:00Z';
      const inRange = starts_at >= url.searchParams.get('start') && starts_at < url.searchParams.get('end');
      const appointment = {
        id: appointmentId, patient_id: patient.id, clinician_id: staff.user_id,
        provider_label: 'Synthetic clinician', patient_name: 'Avery Example',
        starts_at, ends_at: day + 'T10:30:00Z', facility: 'Synthetic clinic',
        status: 'booked', title: 'Synthetic appointment', category: 'office', version: 1
      };
      return {appointments: inRange ? [appointment] : [], blocks: []};
    }
    case personPath: return patient;
    case personPath + '/workspace': return {patient, visits: [], appointments: [], amendments: [], flags: []};
    case personPath + '/banner': return {patient_id: patient.id, revision: 'synthetic', billing: {patient_due_cents: 0}, eligibility: [], flags: {}};
    case personPath + '/demographics': return {content: {}, items: []};
    case personPath + '/identity': return {patient, history: [], version: 1};
    case personPath + '/orders': return {orders: [], reports: [], results: [], specimens: [], acknowledgments: []};
    case personPath + '/billing': return {patient, accounts: [], coverages: [], claims: [], entries: []};
    default: return {...list([]), appointments: [], blocks: [], events: [], forms: [], history: [], orders: [], markers: [], results: [], reviews: []};
  }
}

// Install before parsing starts. Sample computed visibility once per render frame so
// synchronous DOM updates that never reach a paint do not register as flashes.
function observeReload({appointmentId, patientId}) {
  const trace = [];
  window.reloadPaintTrace = trace;
  function visible(selector) {
    return [...document.querySelectorAll(selector)].some(node => {
      if (!node.checkVisibility({opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true})) return false;
      const bounds = node.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.top < innerHeight && bounds.bottom > 0 && bounds.left < innerWidth && bounds.right > 0;
    });
  }
  function sample(now) {
    if (document.body) {
      const painted = [];
      if (visible('#workspace-startup')) painted.push('startup');
      if (visible('#login-screen')) painted.push('sign-in');
      if (visible('#app')) {
        if (visible('#practice-home[aria-busy="true"]')) painted.push('home skeleton');
        else if (visible('#practice-home')) painted.push('home');
        if (visible('#schedule-workspace')) {
          const card = document.querySelector('#schedule-workspace [data-schedule-id="' + appointmentId + '"]');
          painted.push(card && card.getClientRects().length ? 'schedule' : 'schedule without appointment');
        }
        if (visible('#patient-banner[data-patient-id="' + patientId + '"]')) {
          const record = document.querySelector('#patient-identity-panel');
          painted.push(record && record.checkVisibility({visibilityProperty: true}) ? 'patient record' : 'other chart section');
        } else if (visible('.chart-skeleton-content')) painted.push('chart skeleton');
        else if (visible('#clinical-workspace')) painted.push('patient directory');
        if (!painted.some(name => !['startup', 'sign-in'].includes(name))) painted.push('empty app');
      }
      const state = painted.join(' + ') || 'blank';
      const hash = location.hash;
      const scroll = state === 'schedule'
        ? document.querySelector('#schedule-body .grid-scroll')?.scrollTop
        : undefined;
      const last = trace.at(-1);
      if (!last || last.state !== state || last.hash !== hash || last.scroll !== scroll) {
        trace.push({state, hash, scroll, time: Math.round(now)});
      }
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}

const schedule = {
  hash: '#/schedule', surface: 'schedule',
  selector: '#schedule-workspace [data-schedule-id="' + appointmentId + '"]'
};
const record = {hash: '#/patients/' + patient.id + '/record', surface: 'patient record', selector: '#patient-identity-panel:not([hidden])'};
const signIn = {hash: '#/schedule', surface: 'sign-in', selector: '#login-form input[name="email"]'};

async function run(browser, {name, destination, restore = true, signedIn = true, delayed = false}) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    let measuring = !restore;
    const delays = delayed ? new Map([
      ['/auth/me', 220],
      ['/api/v1/patients', 180],
      ['/api/v1/practice/overview', 180],
      ['/api/v1/schedule/providers', 320],
      [personPath + '/workspace', 320]
    ]) : new Map();
    await page.setViewport({width: 1280, height: 900});
    await page.emulateTimezone('UTC');
    await page.setDefaultTimeout(10000);
    await page.evaluateOnNewDocument(observeReload, {appointmentId, patientId: patient.id});
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    async function respond(request) {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      if (request.method() !== 'GET') {
        errors.push('Unexpected write: ' + request.method() + ' ' + url.pathname);
        return request.respond({status: 405, body: 'Read-only reload fixture'});
      }
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) return request.continue();
      if (measuring) requests.push(url.pathname);
      const wait = measuring && delays.get(url.pathname);
      if (wait) await delay(wait);
      const rejected = !signedIn && url.pathname === '/auth/me';
      const body = rejected ? {message: 'Unauthorized'} : fixture(url);
      if (request.isInterceptResolutionHandled()) return;
      return request.respond({status: rejected ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body)});
    }
    page.on('request', request => void respond(request).catch(error => {
      if (!page.isClosed()) errors.push(error.message);
    }));

    async function waitForDestination() {
      try {
        await page.waitForSelector(destination.selector, {visible: true});
      } catch (cause) {
        const observed = await page.evaluate(() => ({
          trace: window.reloadPaintTrace,
          notice: document.querySelector('#notice')?.innerText,
          title: document.querySelector('#page-title')?.textContent
        }));
        throw new Error(name + ' did not reach its destination: ' + JSON.stringify({observed, errors}), {cause});
      }
    }

    await page.goto(origin + '/' + destination.hash, {waitUntil: 'load'});
    let initialScheduleScroll;
    if (restore) {
      await waitForDestination();
      if (destination === schedule) {
        await page.click('[data-schedule-view="day"]');
        await page.waitForSelector('#schedule-workspace .schedule-grid-day', {visible: true});
        initialScheduleScroll = await page.$eval('#schedule-body .grid-scroll', node => node.scrollTop);
        assert.ok(initialScheduleScroll > 0, 'Schedule fixture opens the calendar at the appointment, below the first hour');
      }
      measuring = true;
      await page.reload({waitUntil: 'load'});
      assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload');
    }
    await waitForDestination();
    // Include the first few frames after the final screen mounts to catch late jumps.
    await page.evaluate(() => new Promise(resolve => {
      let remaining = 5;
      function next() {
        if (--remaining) requestAnimationFrame(next);
        else resolve();
      }
      requestAnimationFrame(next);
    }));
    const trace = await page.evaluate(() => window.reloadPaintTrace);
    const sequence = trace.map(({state, hash, time, scroll}) => {
      const position = scroll === undefined ? '' : ' (calendar scroll ' + scroll + ' px)';
      return state + ' ' + hash + ' at ' + time + ' ms' + position;
    });
    console.log(name + ' on ' + origin + ': ' + sequence.join(' → '));
    assert.deepEqual(errors, [], 'Browser errors');
    return {trace, requests, initialScheduleScroll};
  } finally {
    await context.close();
  }
}

function checkTrace({trace, requests, initialScheduleScroll}, {name, destination, delayed}) {
  const painted = trace[0]?.state === 'blank' ? trace.slice(1) : trace;
  const states = painted.map(step => step.state);
  const expected = [destination.surface];
  if (delayed || states[0] === 'startup') expected.unshift('startup');
  assert.deepEqual(states, expected, name);
  assert.ok(trace.every(step => step.hash === destination.hash), name + ' preserves the address throughout startup');
  assert.equal(trace.at(-1)?.scroll, initialScheduleScroll, name + ' opens at the expected calendar scroll position');
  assert.ok(!requests.includes('/api/v1/practice/overview'), name + ' does not load the Home workspace');
}

(async () => {
  const target = process.env.CHART_TEST_BROWSER ? {executablePath: process.env.CHART_TEST_BROWSER} : {channel: 'chrome'};
  const browser = await puppeteer.launch({
    ...target, headless: true, pipe: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run']
  });
  try {
    const cases = [
      {name: 'Schedule reload', destination: schedule},
      {name: 'Schedule reload with slow responses', destination: schedule, delayed: true},
      {name: 'Patient record reload with slow responses', destination: record, delayed: true},
      {name: 'Cold unauthenticated visit', destination: signIn, restore: false, signedIn: false, delayed: true}
    ];
    const traces = [];
    for (const scenario of cases) traces.push(await run(browser, scenario));
    for (const [index, scenario] of cases.entries()) checkTrace(traces[index], scenario);
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
