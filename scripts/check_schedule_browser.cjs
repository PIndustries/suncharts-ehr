// SPDX-License-Identifier: AGPL-3.0-only
// Run with SCHEDULE_TEST_URL=http://127.0.0.1:PORT node scripts/check_schedule_browser.cjs.
// Set SCHEDULE_TEST_ASSETS=web to exercise local assets without a server.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const staticRoot = process.env.SCHEDULE_TEST_ASSETS && path.resolve(process.env.SCHEDULE_TEST_ASSETS);
const mime = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
const origin = new URL(process.env.SCHEDULE_TEST_URL || 'http://127.0.0.1:18095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local preview');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id:id(11), tenant_id:id(12), role:'owner', display_name:'Synthetic owner', email:'staff@example.invalid'};
const providers = ['Dr. North', 'Dr. South'].map((label, index) => ({id:id(20 + index), label}));
const locations = ['Synthetic North', 'Synthetic South'];
const list = items => ({items, total:items.length, next_cursor:null});

function fixture(url, days) {
  switch (url.pathname) {
    case '/auth/me': return staff;
    case '/api/v1/connect/status': return {status:'not_connected', services:{configured:false}, transport:{configured:false}};
    case '/api/v1/practice/overview': return {money:{}, claims:{statuses:{}}};
    case '/api/v1/schedule/providers': return list(providers);
    case '/api/v1/schedule': {
      const appointments = days.flatMap((day, index) => providers.flatMap((provider, providerIndex) => locations.map((facility, locationIndex) => ({
        id:id(100 + index * 4 + providerIndex * 2 + locationIndex), patient_id:id(400 + index * 4 + providerIndex * 2 + locationIndex),
        clinician_id:provider.id, provider_label:provider.label, patient_name:'Synthetic patient ' + providerIndex + '-' + locationIndex,
        starts_at:day + 'T10:00:00Z', ends_at:day + 'T10:30:00Z', facility,
        status:'booked', title:'Synthetic appointment', category:'office', version:1
      }))));
      const inRange = appointment => new Date(appointment.starts_at) >= new Date(url.searchParams.get('start'))
        && new Date(appointment.starts_at) < new Date(url.searchParams.get('end'));
      return {appointments:appointments.filter(inRange), blocks:[]};
    }
    default: return {...list([]), appointments:[], blocks:[], markers:[], events:[], forms:[], history:[], orders:[], results:[], reviews:[]};
  }
}

const viewBody = {day:'.schedule-grid-day', week_grid:'.schedule-grid-week', month:'.month-calendar', week:'.schedule-list-day'};
const mini = '.schedule-mini';
const view = mode => '[data-schedule-view="' + mode + '"]';
const locationControl = location => '[data-schedule-location="' + location + '"]';
const providerControl = provider => '[data-schedule-provider="' + provider.id + '"]';
const dayControl = day => mini + ' [data-calendar-day="' + day + '"]';

async function click(page, selector) {
  await page.waitForSelector(selector, {visible:true});
  await page.click(selector);
}

async function waitMode(page, mode) {
  try {
    await page.waitForSelector('#schedule-workspace ' + viewBody[mode], {visible:true});
    await page.waitForSelector(view(mode) + '[aria-pressed="true"]', {visible:true});
  } catch (cause) {
    const state = await page.evaluate(() => ({
      route:location.hash,
      title:document.querySelector('#page-title')?.textContent,
      mode:document.querySelector('[data-schedule-view][aria-pressed="true"]')?.dataset.scheduleView
    }));
    throw new Error('Expected ' + mode + ' on ' + origin + ', found ' + JSON.stringify(state), {cause});
  }
}

async function navigatePractice(page, id) {
  const destination = '#workspace-navigation #' + id;
  if (await page.$eval(destination, el => Boolean(el.getClientRects().length))) {
    await click(page, destination);
  } else {
    await click(page, '#frame-practice-toggle');
    await click(page, '[data-frame-destination="' + id + '"]');
    await page.waitForSelector('.frame-practice-sheet[open]', {hidden:true});
  }
}

async function checkLayout(page, mode, phone) {
  const scrollOwner = ['day','week_grid'].includes(mode) ? '#schedule-body .grid-scroll' : '#schedule-body';
  const frameControl = await page.$eval('#workspace-navigation #nav-schedule', el => Boolean(el.getClientRects().length))
    ? '#workspace-navigation #nav-schedule' : '#frame-practice-toggle';
  const dimensions = await page.evaluate(({scrollOwner, frameControl}) => {
    const agenda = document.querySelector(scrollOwner);
    const toolbar = document.querySelector('.schedule-commandbar');
    const nav = document.querySelector(frameControl);
    const visible = el => Boolean(el?.getClientRects().length);
    const rect = el => el.getBoundingClientRect();
    const controls = Array.from(toolbar.querySelectorAll('button, summary')).filter(el => visible(el) &&
      (el.matches('summary') || !el.closest('details:not([open])')));
    return {
      agendaHeight:agenda.clientHeight, scrollHeight:agenda.scrollHeight,
      scrollPoint:[rect(agenda).left + Math.min(rect(agenda).width / 2, 180), rect(agenda).top + agenda.clientHeight / 2],
      viewport:innerWidth, documentWidth:document.scrollingElement.scrollWidth,
      toolbarTop:rect(toolbar).top, navTop:rect(nav).top,
      clippedControls:controls.filter(el => rect(el).left < 0 || rect(el).right > innerWidth + 1).map(el => el.innerText),
      navVisible:visible(nav) && rect(nav).top >= 0 && rect(nav).bottom <= innerHeight
    };
  }, {scrollOwner, frameControl});
  assert.equal(dimensions.clippedControls.length, 0, 'Toolbar controls fit: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.documentWidth <= dimensions.viewport + 1, 'No horizontal page overflow: ' + JSON.stringify(dimensions));
  assert.ok(dimensions.navVisible && dimensions.toolbarTop >= 0, 'Practice navigation and Schedule toolbar are in view');
  assert.ok(dimensions.scrollHeight > dimensions.agendaHeight, mode + ' calendar can scroll');
  const currentTop = await page.$eval(scrollOwner, el => el.scrollTop);
  const maxTop = dimensions.scrollHeight - dimensions.agendaHeight;
  assert.ok(maxTop >= 120, mode + ' calendar has enough appointments to exercise scrolling: ' + maxTop);
  const targetTop = currentTop > maxTop / 2 ? 0 : maxTop;
  await page.mouse.move(...dimensions.scrollPoint);
  await page.mouse.wheel({deltaY:targetTop === 0 ? -maxTop : maxTop});
  await page.waitForFunction((selector, top) => Math.abs(document.querySelector(selector).scrollTop - top) < 2, {}, scrollOwner, targetTop);
  const after = await page.evaluate(selector => ({
    toolbarTop:document.querySelector('.schedule-commandbar').getBoundingClientRect().top,
    navTop:document.querySelector(selector).getBoundingClientRect().top,
    documentTop:document.scrollingElement.scrollTop
  }), frameControl);
  assert.ok(Math.abs(after.toolbarTop - dimensions.toolbarTop) <= 1, 'Schedule toolbar stays fixed');
  assert.ok(Math.abs(after.navTop - dimensions.navTop) <= 1, 'Practice navbar stays fixed');
  assert.equal(after.documentTop, 0, 'Only the agenda scrolls');
  if (phone) await click(page, '[data-schedule-filters]');
  await page.waitForSelector(mini, {visible:true});
  assert.equal(await page.$$eval(mini + ' [data-calendar-day]', buttons => buttons.length), 42);
  if (phone) await click(page, '[data-schedule-filters]');
}

async function run(browser, viewport) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const errors = [];
    await page.setViewport(viewport);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion', value:'reduce'}]);
    await page.emulateTimezone('UTC');
    await page.setDefaultTimeout(8000);
    const days = Array.from({length:45}, (_, i) => {
      const t = new Date(); t.setUTCDate(t.getUTCDate() + i - 14);
      return t.toISOString().slice(0,10);
    });
    const today = days[14];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== origin) return void request.abort();
      if (request.method() !== 'GET') {
        errors.push('Unexpected write: ' + request.method() + ' ' + url.pathname);
        return void request.respond({status:405, body:'Read-only browser fixture'});
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        return void request.respond({status:200, contentType:'application/json', body:JSON.stringify(fixture(url, days))});
      }
      if (staticRoot) {
        const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return void request.respond({status:404, body:''});
        }
        const extension = path.extname(file);
        const body = fs.readFileSync(file);
        return void request.respond({status:200, contentType:mime[extension] || 'application/octet-stream', body});
      }
      void request.continue();
    });

    await page.goto(origin + '/#/schedule', {waitUntil:'load'});
    await waitMode(page, 'month');
    for (const mode of ['day','week_grid','month','week']) {
      await click(page, view(mode));
      await waitMode(page, mode);
      await checkLayout(page, mode, viewport.isMobile);
    }

    if (viewport.isMobile) await click(page, '[data-schedule-filters]');
    await click(page, locationControl(locations[0]));
    await click(page, providerControl(providers[0]));
    if (viewport.isMobile) await click(page, '[data-schedule-filters]');
    async function checkPreferences() {
      await waitMode(page, 'week');
      if (viewport.isMobile) await click(page, '[data-schedule-filters]');
      assert.equal(await page.$eval(locationControl(locations[0]), el => el.checked), false);
      assert.equal(await page.$eval(providerControl(providers[0]), el => el.checked), false);
      assert.equal(await page.$eval(locationControl(locations[1]), el => el.checked), true);
      assert.equal(await page.$eval(providerControl(providers[1]), el => el.checked), true);
      assert.equal(await page.$eval(dayControl(today), el => el.getAttribute('aria-pressed')), 'true');
      if (viewport.isMobile) await click(page, '[data-schedule-filters]');
      assert.equal(await page.$$eval('[data-schedule-open]', cards => cards.length), 7);
      assert.match(await page.$eval('#schedule-body', el => el.innerText), /Synthetic patient 1-1/i);
      assert.doesNotMatch(await page.$eval('#schedule-body', el => el.innerText), /Synthetic patient (0-|1-0)/i);
    }
    await checkPreferences();
    await navigatePractice(page, 'nav-practice');
    await page.waitForFunction(() => location.hash === '#/home');
    await navigatePractice(page, 'nav-schedule');
    await checkPreferences();
    await page.reload({waitUntil:'load'});
    await checkPreferences();
    assert.deepEqual(errors, []);
    console.log('PASS Schedule at ' + viewport.width + ' × ' + viewport.height + ' on ' + origin);
  } finally {
    await context.close();
  }
}

(async () => {
  const target = process.env.CHART_TEST_BROWSER ? {executablePath:process.env.CHART_TEST_BROWSER} : {channel:'chrome'};
  const browser = await puppeteer.launch({...target, headless:true, pipe:true, args:['--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run']});
  try {
    for (const viewport of [{width:1280,height:900},{width:390,height:844,isMobile:true,hasTouch:true}]) await run(browser, viewport);
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
